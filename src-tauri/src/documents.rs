//! Converter for text documents and spreadsheets.
//!
//! - Documents (txt, md, html, pdf, docx) → txt, md, html, docx, pdf.
//!   The intermediate form is Markdown or plain text. PDF output prints the HTML with
//!   the Edge that ships with Windows (headless); PDF input only reads the text.
//! - Spreadsheets (xlsx, xls, ods, csv, tsv) → xlsx, csv, json, html, pdf. First sheet only.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};

pub const DOC_IN: &[&str] = &["txt", "md", "markdown", "html", "htm", "pdf", "docx"];
pub const TABLE_IN: &[&str] = &["xlsx", "xlsm", "xls", "ods", "csv", "tsv"];

/// Parsed content: Markdown keeps headings/lists, text is just lines.
enum Source {
    Plain(String),
    Markdown(String),
}

pub fn convert_document(input: &Path, output: &Path, ext: &str, target: &str) -> Result<(), String> {
    let source = read_document(input, ext)?;
    let title = input.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    match target {
        "txt" => write_text(output, &to_plain(&source)),
        "md" => write_text(output, &match &source {
            Source::Markdown(md) => md.clone(),
            Source::Plain(t) => t.clone(),
        }),
        "html" => write_text(output, &to_html(&source, &title)),
        "docx" => write_docx(output, &source),
        "pdf" => print_pdf(&to_html(&source, &title), output),
        _ => Err("Zielformat für Dokumente nicht verfügbar".into()),
    }
}

pub fn convert_table(input: &Path, output: &Path, ext: &str, target: &str) -> Result<(), String> {
    let rows = read_table(input, ext)?;
    if rows.is_empty() {
        return Err("Tabelle ist leer".into());
    }
    let title = input.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    match target {
        "csv" => write_csv(output, &rows),
        "xlsx" => write_xlsx(output, &rows),
        "json" => write_json(output, &rows),
        "html" => write_text(output, &table_html(&rows, &title)),
        "pdf" => print_pdf(&table_html(&rows, &title), output),
        _ => Err("Zielformat für Tabellen nicht verfügbar".into()),
    }
}

// ── Reading ──────────────────────────────────────────────────────────────────

fn read_document(input: &Path, ext: &str) -> Result<Source, String> {
    let text = || {
        let bytes = std::fs::read(input).map_err(|e| format!("Datei nicht lesbar: {e}"))?;
        Ok::<_, String>(String::from_utf8_lossy(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes)).into_owned())
    };
    Ok(match ext {
        "txt" => Source::Plain(text()?),
        "md" | "markdown" => Source::Markdown(text()?),
        "html" | "htm" => Source::Markdown(html_to_markdown(&text()?)),
        "pdf" => Source::Plain(tidy_pdf_text(&pdf_extract::extract_text(input).map_err(|_| "PDF-Text nicht lesbar (evtl. nur Bilder/Scan)".to_string())?)),
        "docx" => Source::Markdown(docx_to_markdown(input)?),
        _ => return Err("Format wird nicht unterstützt".into()),
    })
}

/// pdf-extract emits lots of blank lines; collapse them to at most one.
fn tidy_pdf_text(s: &str) -> String {
    let mut out = String::new();
    let mut blank = 0;
    for line in s.lines().map(str::trim_end) {
        if line.trim().is_empty() {
            blank += 1;
            if blank == 1 && !out.is_empty() {
                out.push('\n');
            }
        } else {
            blank = 0;
            out.push_str(line);
            out.push('\n');
        }
    }
    out.trim().to_string() + "\n"
}

/// Paragraphs from word/document.xml; headings and lists become Markdown.
fn docx_to_markdown(input: &Path) -> Result<String, String> {
    use quick_xml::events::Event as X;
    let file = std::fs::File::open(input).map_err(|e| format!("Datei nicht lesbar: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "Keine gültige DOCX-Datei".to_string())?;
    let mut xml = String::new();
    zip.by_name("word/document.xml")
        .map_err(|_| "Keine gültige DOCX-Datei".to_string())?
        .read_to_string(&mut xml)
        .map_err(|e| e.to_string())?;

    let mut reader = quick_xml::Reader::from_str(&xml);
    let mut out = String::new();
    let (mut para, mut heading, mut list, mut in_text) = (String::new(), 0usize, false, false);
    loop {
        match reader.read_event() {
            Ok(X::Start(e)) | Ok(X::Empty(e)) => match AsRef::<str>::as_ref(&e.local_name()) {
                "p" => (para, heading, list) = (String::new(), 0, false),
                "t" => in_text = true,
                "tab" => para.push('\t'),
                "br" => para.push('\n'),
                "numPr" => list = true,
                "pStyle" => {
                    if let Some(v) = e.attributes().flatten().find(|a| AsRef::<str>::as_ref(&a.key.local_name()) == "val") {
                        let v = v.value.to_lowercase();
                        // "Heading1", "berschrift1" (German Word), "Title".
                        if v.starts_with("heading") || v.contains("berschrift") {
                            heading = v.chars().filter(char::is_ascii_digit).collect::<String>().parse().unwrap_or(1).clamp(1, 6);
                        } else if v == "title" {
                            heading = 1;
                        }
                    }
                }
                _ => {}
            },
            Ok(X::Text(t)) if in_text => para.push_str(&t.xml_content(quick_xml::XmlVersion::Implicit1_0)),
            Ok(X::GeneralRef(r)) if in_text => {
                para.push_str(match AsRef::<str>::as_ref(&r) {
                    "amp" => "&",
                    "lt" => "<",
                    "gt" => ">",
                    "quot" => "\"",
                    "apos" => "'",
                    _ => "",
                });
            }
            Ok(X::End(e)) => match AsRef::<str>::as_ref(&e.local_name()) {
                "t" => in_text = false,
                "p" => {
                    let text = para.trim();
                    let is_list = (list || text.starts_with("• ")) && !text.is_empty();
                    // Blank line after a list before the next non-list paragraph.
                    if !is_list && out.ends_with('\n') && !out.ends_with("\n\n") {
                        out.push('\n');
                    }
                    if heading > 0 && !text.is_empty() {
                        out.push_str(&format!("{} {text}\n\n", "#".repeat(heading)));
                    } else if is_list {
                        out.push_str(&format!("- {}\n", text.trim_start_matches("• ")));
                    } else if !text.is_empty() {
                        out.push_str(text);
                        out.push_str("\n\n");
                    }
                }
                _ => {}
            },
            Ok(X::Eof) => break,
            Err(_) => return Err("DOCX-Inhalt nicht lesbar".into()),
            _ => {}
        }
    }
    Ok(out.trim_end().to_string() + "\n")
}

/// Rough HTML → Markdown (headings, paragraphs, lists, line breaks).
fn html_to_markdown(html: &str) -> String {
    let body = html.find("<body").and_then(|i| html[i..].find('>').map(|j| &html[i + j + 1..])).unwrap_or(html);
    let mut out = String::new();
    let mut rest = body;
    let mut skip = false;
    while let Some(lt) = rest.find('<') {
        if !skip {
            out.push_str(&decode_entities(&collapse_spaces(&rest[..lt])));
        }
        let Some(gt) = rest[lt..].find('>') else { break };
        let tag = rest[lt + 1..lt + gt].trim().to_lowercase();
        rest = &rest[lt + gt + 1..];
        let name: String = tag.trim_start_matches('/').chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
        let closing = tag.starts_with('/');
        match name.as_str() {
            "script" | "style" | "head" => skip = !closing,
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" if !closing => {
                out.push_str("\n\n");
                out.push_str(&"#".repeat(name[1..].parse().unwrap_or(1)));
                out.push(' ');
            }
            "li" if !closing => out.push_str("\n- "),
            "br" => out.push('\n'),
            "p" | "div" | "section" | "article" | "ul" | "ol" | "table" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => out.push_str("\n\n"),
            "td" | "th" if closing => out.push_str(" | "),
            _ => {}
        }
    }
    if !skip {
        out.push_str(&decode_entities(rest));
    }
    // Collapse blank lines, trim lines.
    let mut tidy = String::new();
    for line in out.lines().map(str::trim) {
        if line.is_empty() && (tidy.is_empty() || tidy.ends_with("\n\n")) {
            continue;
        }
        tidy.push_str(line);
        tidy.push('\n');
    }
    tidy.trim().to_string() + "\n"
}

/// Collapses whitespace to one space but keeps the edges ("A <b>paragraph</b>").
fn collapse_spaces(s: &str) -> String {
    let mut out = String::new();
    let mut space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            space = true;
        } else {
            if space {
                out.push(' ');
            }
            space = false;
            out.push(c);
        }
    }
    if space {
        out.push(' ');
    }
    out
}

fn decode_entities(s: &str) -> String {
    s.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&")
}

fn read_table(input: &Path, ext: &str) -> Result<Vec<Vec<String>>, String> {
    use calamine::Reader;
    if ext == "csv" || ext == "tsv" {
        let bytes = std::fs::read(input).map_err(|e| format!("Datei nicht lesbar: {e}"))?;
        let text = String::from_utf8_lossy(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes)).into_owned();
        // Guess the delimiter: the most common one in the first line (German Excel uses ";").
        let first = text.lines().next().unwrap_or("");
        let delimiter = if ext == "tsv" { b'\t' } else { [b';', b',', b'\t'].into_iter().max_by_key(|d| first.matches(*d as char).count()).unwrap_or(b',') };
        let mut reader = csv::ReaderBuilder::new().delimiter(delimiter).has_headers(false).flexible(true).from_reader(text.as_bytes());
        return reader
            .records()
            .map(|r| r.map(|rec| rec.iter().map(str::to_string).collect()).map_err(|_| "CSV nicht lesbar".to_string()))
            .collect();
    }
    let mut book = calamine::open_workbook_auto(input).map_err(|_| "Tabelle nicht lesbar".to_string())?;
    let range = book.worksheet_range_at(0).ok_or("Tabelle hat kein Blatt")?.map_err(|_| "Tabelle nicht lesbar".to_string())?;
    Ok(range.rows().map(|row| row.iter().map(cell_text).collect()).collect())
}

fn cell_text(c: &calamine::Data) -> String {
    use calamine::{Data, DataType};
    match c {
        Data::Empty => String::new(),
        // Dates as 2026-10-05 (with time if present), not as Excel serial numbers.
        Data::DateTime(_) => c
            .as_datetime()
            .map(|d| d.to_string().trim_end_matches(" 00:00:00").to_string())
            .unwrap_or_else(|| c.to_string()),
        _ => c.to_string(),
    }
}

// ── Writing ──────────────────────────────────────────────────────────────────

fn write_text(output: &Path, text: &str) -> Result<(), String> {
    std::fs::write(output, text).map_err(|e| format!("Kann nicht speichern: {e}"))
}

fn md_parser(md: &str) -> Parser<'_> {
    Parser::new_ext(md, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS)
}

fn to_plain(source: &Source) -> String {
    let md = match source {
        Source::Plain(t) => return t.clone(),
        Source::Markdown(md) => md,
    };
    let mut out = String::new();
    for ev in md_parser(md) {
        match ev {
            Event::Text(t) | Event::Code(t) => out.push_str(&t),
            Event::SoftBreak | Event::HardBreak => out.push('\n'),
            Event::Start(Tag::Item) => out.push_str("• "),
            Event::End(TagEnd::Paragraph | TagEnd::Heading(_) | TagEnd::CodeBlock | TagEnd::Item | TagEnd::TableRow | TagEnd::TableHead) => out.push('\n'),
            Event::End(TagEnd::TableCell) => out.push('\t'),
            Event::End(TagEnd::List(_)) => out.push('\n'),
            _ => {}
        }
    }
    out.trim().to_string() + "\n"
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

const PAGE_CSS: &str = "body{font:11pt/1.55 'Segoe UI',system-ui,sans-serif;color:#1d1d1f;max-width:46em;margin:2.2em auto;padding:0 1.5em}\
h1,h2,h3{line-height:1.25;margin:1.4em 0 .5em}h1{font-size:1.8em}h2{font-size:1.4em}h3{font-size:1.15em}\
pre,code{font-family:Consolas,monospace;background:#f2f2f4;border-radius:6px}pre{padding:.8em 1em;white-space:pre-wrap}code{padding:.1em .3em}\
table{border-collapse:collapse;font-size:10pt;width:100%}td,th{border:1px solid #d2d2d7;padding:.35em .6em;text-align:left;vertical-align:top}\
th{background:#f2f2f4;font-weight:600}tr:nth-child(even) td{background:#fafafa}@page{margin:16mm}";

fn page(title: &str, body: &str) -> String {
    format!("<!doctype html><html><head><meta charset=\"utf-8\"><title>{}</title><style>{PAGE_CSS}</style></head><body>\n{body}\n</body></html>\n", escape(title))
}

fn to_html(source: &Source, title: &str) -> String {
    let body = match source {
        Source::Markdown(md) => {
            let mut html = String::new();
            pulldown_cmark::html::push_html(&mut html, md_parser(md));
            html
        }
        Source::Plain(t) => t
            .split("\n\n")
            .filter(|p| !p.trim().is_empty())
            .map(|p| format!("<p>{}</p>\n", escape(p.trim()).replace('\n', "<br>")))
            .collect(),
    };
    page(title, &body)
}

fn table_html(rows: &[Vec<String>], title: &str) -> String {
    let mut body = String::from("<table>\n");
    for (i, row) in rows.iter().enumerate() {
        let cell = if i == 0 { "th" } else { "td" };
        body.push_str("<tr>");
        for c in row {
            body.push_str(&format!("<{cell}>{}</{cell}>", escape(c)));
        }
        body.push_str("</tr>\n");
    }
    body.push_str("</table>");
    page(title, &body)
}

fn write_csv(output: &Path, rows: &[Vec<String>]) -> Result<(), String> {
    // ";" + BOM so German Excel opens the file correctly right away.
    let mut w = csv::WriterBuilder::new().delimiter(b';').flexible(true).from_writer(Vec::from(&b"\xEF\xBB\xBF"[..]));
    for row in rows {
        w.write_record(row).map_err(|e| e.to_string())?;
    }
    let bytes = w.into_inner().map_err(|e| e.to_string())?;
    std::fs::write(output, bytes).map_err(|e| format!("Kann nicht speichern: {e}"))
}

fn write_xlsx(output: &Path, rows: &[Vec<String>]) -> Result<(), String> {
    let mut book = rust_xlsxwriter::Workbook::new();
    let sheet = book.add_worksheet();
    let bold = rust_xlsxwriter::Format::new().set_bold();
    for (r, row) in rows.iter().enumerate() {
        for (c, value) in row.iter().enumerate() {
            let (r, c) = (r as u32, c as u16);
            let res = match (r, as_number(value)) {
                (0, _) => sheet.write_string_with_format(r, c, value, &bold).map(|_| ()),
                (_, Some(n)) => sheet.write_number(r, c, n).map(|_| ()),
                _ => sheet.write_string(r, c, value).map(|_| ()),
            };
            res.map_err(|e| e.to_string())?;
        }
    }
    sheet.autofit();
    book.save(output).map_err(|e| format!("Kann nicht speichern: {e}"))
}

/// Detects numbers (also "1,5" from German CSV); "007" or postcodes stay text.
fn as_number(value: &str) -> Option<f64> {
    let v = value.trim();
    if v.is_empty() || (v.len() > 1 && v.starts_with('0') && !v.starts_with("0,") && !v.starts_with("0.")) {
        return None;
    }
    v.replace(',', ".").parse().ok()
}

fn write_json(output: &Path, rows: &[Vec<String>]) -> Result<(), String> {
    // First row = column names → list of objects.
    let header = &rows[0];
    let items: Vec<serde_json::Value> = rows[1..]
        .iter()
        .map(|row| {
            let obj = header
                .iter()
                .enumerate()
                .map(|(i, h)| {
                    let key = if h.is_empty() { format!("Spalte {}", i + 1) } else { h.clone() };
                    (key, serde_json::Value::String(row.get(i).cloned().unwrap_or_default()))
                })
                .collect();
            serde_json::Value::Object(obj)
        })
        .collect();
    let text = serde_json::to_string_pretty(&items).map_err(|e| e.to_string())?;
    write_text(output, &(text + "\n"))
}

/// Minimal DOCX (opens in Word, LibreOffice, Google Docs): paragraphs, headings, lists.
fn write_docx(output: &Path, source: &Source) -> Result<(), String> {
    let mut body = String::new();
    let para = |style: Option<&str>, text: &str| {
        let style = style.map(|s| format!("<w:pPr><w:pStyle w:val=\"{s}\"/></w:pPr>")).unwrap_or_default();
        let runs: Vec<String> = text.split('\n').map(|l| format!("<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r>", escape(l))).collect();
        format!("<w:p>{style}{}</w:p>", runs.join("<w:r><w:br/></w:r>"))
    };
    match source {
        Source::Plain(t) => {
            for p in t.split("\n\n").filter(|p| !p.trim().is_empty()) {
                body.push_str(&para(None, p.trim()));
            }
        }
        Source::Markdown(md) => {
            let (mut text, mut style) = (String::new(), None::<String>);
            for ev in md_parser(md) {
                let ends_para = matches!(ev, Event::End(TagEnd::Paragraph));
                match ev {
                    Event::Start(Tag::Heading { level, .. }) => {
                        let n = match level {
                            HeadingLevel::H1 => 1,
                            HeadingLevel::H2 => 2,
                            _ => 3,
                        };
                        style = Some(format!("Heading{n}"));
                    }
                    Event::Start(Tag::Item) => style = Some("ListBullet".into()),
                    Event::Start(Tag::CodeBlock(_)) => style = Some("Code".into()),
                    Event::Text(t) | Event::Code(t) => text.push_str(&t),
                    Event::SoftBreak => text.push(' '),
                    Event::HardBreak => text.push('\n'),
                    Event::End(TagEnd::Paragraph | TagEnd::Heading(_) | TagEnd::Item | TagEnd::CodeBlock) => {
                        if !text.trim().is_empty() {
                            body.push_str(&para(style.as_deref(), text.trim_end()));
                        }
                        text.clear();
                        // Paragraph inside a list item: keep the style until the item ends.
                        if !ends_para || style.as_deref() != Some("ListBullet") {
                            style = None;
                        }
                    }
                    Event::End(TagEnd::List(_)) => style = None,
                    _ => {}
                }
            }
        }
    }

    const NS: &str = "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"";
    let document = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document {NS}><w:body>{body}<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1134\" w:right=\"1134\" w:bottom=\"1134\" w:left=\"1134\" w:header=\"708\" w:footer=\"708\" w:gutter=\"0\"/></w:sectPr></w:body></w:document>");
    let style = |id: &str, size: u32, bold: bool, extra: &str| {
        format!("<w:style w:type=\"paragraph\" w:styleId=\"{id}\"><w:name w:val=\"{id}\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:spacing w:before=\"240\" w:after=\"120\"/>{extra}</w:pPr><w:rPr>{}<w:sz w:val=\"{size}\"/></w:rPr></w:style>", if bold { "<w:b/>" } else { "" })
    };
    let styles = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:styles {NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=\"Segoe UI\" w:hAnsi=\"Segoe UI\" w:cs=\"Segoe UI\"/><w:sz w:val=\"22\"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after=\"160\" w:line=\"300\" w:lineRule=\"auto\"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/></w:style>{}{}{}{}{}</w:styles>",
        style("Heading1", 36, true, "<w:outlineLvl w:val=\"0\"/>"),
        style("Heading2", 30, true, "<w:outlineLvl w:val=\"1\"/>"),
        style("Heading3", 26, true, "<w:outlineLvl w:val=\"2\"/>"),
        style("ListBullet", 22, false, "<w:ind w:left=\"360\" w:hanging=\"0\"/>"),
        style("Code", 20, false, "<w:shd w:val=\"clear\" w:fill=\"F2F2F4\"/>"),
    );
    // List items without a numbering definition: prefix "• ".
    let document = document.replace("<w:pStyle w:val=\"ListBullet\"/></w:pPr><w:r><w:t xml:space=\"preserve\">", "<w:pStyle w:val=\"ListBullet\"/></w:pPr><w:r><w:t xml:space=\"preserve\">• ");

    let files: [(&str, String); 4] = [
        ("[Content_Types].xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/><Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/></Types>".into()),
        ("_rels/.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>".into()),
        ("word/_rels/document.xml.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/></Relationships>".into()),
        ("word/styles.xml", styles),
    ];
    let file = std::fs::File::create(output).map_err(|e| format!("Kann nicht speichern: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let result = (|| -> zip::result::ZipResult<()> {
        for (name, content) in files.iter().map(|(n, c)| (*n, c.as_str())).chain([("word/document.xml", document.as_str())]) {
            zip.start_file(name, opts)?;
            zip.write_all(content.as_bytes())?;
        }
        zip.finish()?;
        Ok(())
    })();
    result.map_err(|e| {
        let _ = std::fs::remove_file(output);
        format!("Kann nicht speichern: {e}")
    })
}

/// Prints HTML to PDF with headless Edge (ships with Windows) or Chrome.
fn print_pdf(html: &str, output: &Path) -> Result<(), String> {
    let browser = pdf_browser().ok_or("Für PDF wird Microsoft Edge oder Chrome benötigt")?;
    let dir = std::env::temp_dir().join(format!("notch-pdf-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let page = dir.join("page.html");
    std::fs::write(&page, html).map_err(|e| e.to_string())?;

    let mut cmd = Command::new(browser);
    cmd.arg("--headless")
        .arg("--disable-gpu")
        .arg("--no-pdf-header-footer")
        .arg("--no-first-run")
        // Separate profile, otherwise an already open Edge takes over and nothing is written.
        .arg(format!("--user-data-dir={}", dir.join("profile").display()))
        .arg(format!("--print-to-pdf={}", output.display()))
        .arg(format!("file:///{}", page.display().to_string().replace('\\', "/")));
    crate::convert::hide_console(&mut cmd);
    let status = cmd.output().map_err(|e| format!("PDF-Druck startet nicht: {e}"))?;
    let _ = std::fs::remove_dir_all(&dir);
    if status.status.success() && output.metadata().is_ok_and(|m| m.len() > 0) {
        Ok(())
    } else {
        let _ = std::fs::remove_file(output);
        Err("PDF konnte nicht erstellt werden".into())
    }
}

fn pdf_browser() -> Option<PathBuf> {
    let bases = ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"].into_iter().filter_map(std::env::var_os).map(PathBuf::from);
    bases
        .flat_map(|b| [b.join("Microsoft\\Edge\\Application\\msedge.exe"), b.join("Google\\Chrome\\Application\\chrome.exe")])
        .find(|p| p.is_file())
}

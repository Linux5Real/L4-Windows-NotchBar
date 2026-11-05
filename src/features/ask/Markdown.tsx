import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";

/**
 * Compact Markdown for Ask replies. The notch is small, so paragraphs, lists
 * and code stay tight; paths and commands are forced LTR even in Arabic text.
 */
const components: Components = {
  p: ({ children }) => <p className="m-0 leading-[1.75] [&:not(:first-child)]:mt-1.5">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-label">{children}</strong>,
  em: ({ children }) => <em className="italic text-label-2">{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      dir="ltr"
      className="text-link underline underline-offset-2 decoration-link/40 hover:decoration-link"
    >
      {children}
    </a>
  ),
  img: () => null,
  ul: ({ children }) => <ul className="my-1.5 list-disc space-y-1 ps-4 marker:text-label-3">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-1 ps-4 marker:text-label-3">{children}</ol>,
  li: ({ children }) => <li className="leading-[1.75] [&>p]:m-0">{children}</li>,
  pre: ({ children }) => (
    <pre
      dir="ltr"
      className="my-2 overflow-x-auto rounded-[10px] border border-label-4/15 bg-fill-1 p-2.5 text-caption text-label-2 [&_code]:bg-transparent [&_code]:p-0"
    >
      {children}
    </pre>
  ),
  code: ({ children }) => (
    <code
      dir="ltr"
      className="rounded bg-fill-2 px-1 py-0.5 font-mono text-[0.9em] text-label-2"
    >
      {children}
    </code>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-s-2 border-label-4/40 ps-2 text-label-3">
      {children}
    </blockquote>
  ),
  h1: ({ children }) => <h1 className="mt-2 mb-1 text-body font-semibold text-label">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-2 mb-1 text-body font-semibold text-label">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-1.5 mb-1 text-caption font-semibold text-label">{children}</h3>,
  hr: () => <hr className="my-2 border-label-4/20" />,
};

export function MarkdownText({ text, dir }: { text: string; dir?: "rtl" | "ltr" }) {
  return (
    <div dir={dir} className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown components={components} remarkPlugins={[remarkBreaks]} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
}

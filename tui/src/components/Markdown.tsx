// Lightweight markdown renderer for assistant text. Handles the patterns
// LLMs actually emit:
//   - **bold**  *italic*  `inline code`
//   - ``` fenced code blocks ```
//   - # heading  ## heading
//   - "- " / "* "  bulleted lists
//   - "1. "        numbered lists  (cyan number, Codex style)
//   - > blockquote
//
// Output is OpenTUI <text>/<box> elements. Inline styling builds StyledText
// directly from TextChunks (the class OpenTUI's <text content> consumes).

import { Fragment, type ReactNode } from "react"
import { fg, bg, bold, italic, t, StyledText, type TextChunk } from "@opentui/core"
import { theme } from "../theme.js"

export function Markdown({ text, prefix }: { text: string; prefix?: TextChunk }) {
  const blocks = parseBlocks(text)
  // Drop the prefix unless the very first block is a paragraph — bullets
  // glued to a code block or heading look noisy.
  const firstIsParagraph = blocks.length > 0 && blocks[0].kind === "paragraph"
  return (
    <Fragment>
      {blocks.map((b, i) =>
        renderBlock(b, i, i === 0 && firstIsParagraph ? prefix : undefined),
      )}
    </Fragment>
  )
}

// ── block-level parser ─────────────────────────────────────────────

type Block =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "code"; lang: string; content: string }
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "bullet"; items: string[] }
  | { kind: "numbered"; items: string[] }
  | { kind: "quote"; lines: string[] }

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  const rawLines = text.split("\n")
  let i = 0

  while (i < rawLines.length) {
    const line = rawLines[i]

    const fenceMatch = line.match(/^```(\w*)/)
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? ""
      const buf: string[] = []
      i++
      while (i < rawLines.length && !rawLines[i].startsWith("```")) {
        buf.push(rawLines[i])
        i++
      }
      i++ // skip closing fence
      blocks.push({ kind: "code", lang, content: buf.join("\n") })
      continue
    }

    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) {
      blocks.push({ kind: "heading", level: h[1].length as 1 | 2 | 3, text: h[2] })
      i++
      continue
    }

    if (line.match(/^[-*]\s/)) {
      const items: string[] = []
      while (i < rawLines.length && rawLines[i].match(/^[-*]\s/)) {
        items.push(rawLines[i].replace(/^[-*]\s/, ""))
        i++
      }
      blocks.push({ kind: "bullet", items })
      continue
    }

    if (line.match(/^\d+\.\s/)) {
      const items: string[] = []
      while (i < rawLines.length && rawLines[i].match(/^\d+\.\s/)) {
        items.push(rawLines[i].replace(/^\d+\.\s/, ""))
        i++
      }
      blocks.push({ kind: "numbered", items })
      continue
    }

    if (line.startsWith("> ")) {
      const buf: string[] = []
      while (i < rawLines.length && rawLines[i].startsWith("> ")) {
        buf.push(rawLines[i].slice(2))
        i++
      }
      blocks.push({ kind: "quote", lines: buf })
      continue
    }

    if (line.trim() === "") {
      i++
      continue
    }

    const paraLines: string[] = []
    while (
      i < rawLines.length
      && rawLines[i].trim() !== ""
      && !rawLines[i].match(/^```/)
      && !rawLines[i].match(/^#{1,3}\s/)
      && !rawLines[i].match(/^[-*]\s/)
      && !rawLines[i].match(/^\d+\.\s/)
      && !rawLines[i].startsWith("> ")
    ) {
      paraLines.push(rawLines[i])
      i++
    }
    if (paraLines.length > 0) blocks.push({ kind: "paragraph", lines: paraLines })
  }

  return blocks
}

// ── block renderer ─────────────────────────────────────────────────

function renderBlock(block: Block, key: number, prefix?: TextChunk): ReactNode {
  switch (block.kind) {
    case "paragraph":
      return (
        <Fragment key={key}>
          {block.lines.map((line, i) => {
            const chunks = inlineChunks(line, theme.assistant)
            const withPrefix = i === 0 && prefix ? [prefix, ...chunks] : chunks
            return <text key={i} content={styled(withPrefix)} />
          })}
        </Fragment>
      )

    case "code":
      return (
        <box key={key} flexDirection="column" marginTop={1} marginBottom={1}>
          {block.lang ? (
            <text content={"  " + block.lang} fg={theme.dim} />
          ) : null}
          {block.content.split("\n").map((line, i) => (
            <text
              key={i}
              content={t`${fg(theme.branch)("│ ")}${fg(theme.assistant)(line.length > 0 ? line : " ")}`}
            />
          ))}
        </box>
      )

    case "heading":
      return (
        <box key={key} marginTop={1}>
          <text content={styled([applyBold(applyFg(block.text, theme.assistant))])} />
        </box>
      )

    case "bullet":
      return (
        <Fragment key={key}>
          {block.items.map((item, i) => (
            <text
              key={i}
              content={styled([
                applyFg("  • ", theme.bullet),
                ...inlineChunks(item, theme.assistant),
              ])}
            />
          ))}
        </Fragment>
      )

    case "numbered":
      return (
        <Fragment key={key}>
          {block.items.map((item, i) => (
            <text
              key={i}
              content={styled([
                applyFg(`  ${i + 1}. `, theme.number),
                ...inlineChunks(item, theme.assistant),
              ])}
            />
          ))}
        </Fragment>
      )

    case "quote":
      return (
        <Fragment key={key}>
          {block.lines.map((line, i) => (
            <text
              key={i}
              content={styled([
                applyFg("│ ", theme.dim),
                ...inlineChunks(line, theme.dim),
              ])}
            />
          ))}
        </Fragment>
      )
  }
}

// ── inline parser & styling helpers ────────────────────────────────

function renderInline(line: string, defaultColor: string): StyledText {
  return styled(inlineChunks(line, defaultColor))
}

function inlineChunks(line: string, defaultColor: string): TextChunk[] {
  const tokens = tokenizeInline(line)
  return tokens.map(tok => styleToken(tok, defaultColor))
}

type Token =
  | { kind: "text"; v: string }
  | { kind: "bold"; v: string }
  | { kind: "italic"; v: string }
  | { kind: "code"; v: string }

function tokenizeInline(line: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < line.length) {
    if (line[i] === "`") {
      const end = line.indexOf("`", i + 1)
      if (end > i) {
        out.push({ kind: "code", v: line.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    if (line[i] === "*" && line[i + 1] === "*") {
      const end = line.indexOf("**", i + 2)
      if (end > i + 1) {
        out.push({ kind: "bold", v: line.slice(i + 2, end) })
        i = end + 2
        continue
      }
    }
    if ((line[i] === "*" || line[i] === "_") && line[i + 1] && line[i + 1] !== " ") {
      const ch = line[i]
      const end = line.indexOf(ch, i + 1)
      if (end > i + 1 && line[end - 1] !== " ") {
        out.push({ kind: "italic", v: line.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    let j = i
    while (j < line.length && line[j] !== "`" && line[j] !== "*" && line[j] !== "_") j++
    if (j === i) j = i + 1
    out.push({ kind: "text", v: line.slice(i, j) })
    i = j
  }
  return out
}

function styleToken(tok: Token, defaultColor: string): TextChunk {
  switch (tok.kind) {
    case "text":   return applyFg(tok.v, defaultColor)
    case "bold":   return applyBold(applyFg(tok.v, defaultColor))
    case "italic": return applyItalic(applyFg(tok.v, defaultColor))
    case "code":   return applyBold(applyFg(tok.v, defaultColor))
  }
}

// applyFg/Bg/Bold/Italic each return a TextChunk. They composes via
// OpenTUI's chunk-level helpers; we don't go through the t`` template.

function applyFg(input: string | TextChunk, color: string): TextChunk {
  return fg(color)(input)
}
function applyBg(input: string | TextChunk, color: string): TextChunk {
  return bg(color)(input)
}
function applyBold(input: string | TextChunk): TextChunk {
  return bold(input)
}
function applyItalic(input: string | TextChunk): TextChunk {
  return italic(input)
}

function styled(chunks: TextChunk[]): StyledText {
  return new StyledText(chunks)
}

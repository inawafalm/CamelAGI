// Markdown → Telegram HTML converter
// Telegram supports a subset of HTML: <b>, <i>, <u>, <s>, <code>, <pre>, <a>
// This converts common markdown patterns to Telegram-safe HTML.

/** Escape HTML entities in plain text */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Convert markdown text to Telegram-compatible HTML.
 * Falls back to escaped plain text if conversion fails.
 */
export function markdownToTelegramHtml(text: string): string {
  try {
    return convert(text);
  } catch {
    return escapeHtml(text);
  }
}

function convert(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeBlockLines: string[] = [];

  for (const line of lines) {
    // Code block toggle
    if (line.trimStart().startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.trimStart().slice(3).trim();
        codeBlockLines = [];
        continue;
      } else {
        // Close code block
        inCodeBlock = false;
        const code = escapeHtml(codeBlockLines.join("\n"));
        if (codeBlockLang) {
          result.push(`<pre><code class="language-${escapeHtml(codeBlockLang)}">${code}</code></pre>`);
        } else {
          result.push(`<pre>${code}</pre>`);
        }
        continue;
      }
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    // Process non-code-block line
    result.push(formatLine(line));
  }

  // Handle unclosed code block
  if (inCodeBlock) {
    const code = escapeHtml(codeBlockLines.join("\n"));
    result.push(`<pre>${code}</pre>`);
  }

  return result.join("\n");
}

function formatLine(line: string): string {
  // Headers → bold
  const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
  if (headerMatch) {
    return `<b>${formatInline(headerMatch[2])}</b>`;
  }

  // Horizontal rule
  if (/^[-*_]{3,}\s*$/.test(line)) {
    return "—————";
  }

  // Bullet lists — keep the bullet, format content
  const bulletMatch = line.match(/^(\s*)[*\-+]\s+(.+)$/);
  if (bulletMatch) {
    return `${bulletMatch[1]}• ${formatInline(bulletMatch[2])}`;
  }

  // Numbered lists
  const numMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
  if (numMatch) {
    return `${numMatch[1]}${formatInline(numMatch[2])}`;
  }

  // Blockquote
  if (line.startsWith("> ")) {
    return `│ ${formatInline(line.slice(2))}`;
  }

  return formatInline(line);
}

function formatInline(text: string): string {
  let result = escapeHtml(text);

  // Inline code (must be before bold/italic to avoid conflicts)
  result = result.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold + italic
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");

  // Bold
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  result = result.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic
  result = result.replace(/\*(.+?)\*/g, "<i>$1</i>");
  result = result.replace(/_(.+?)_/g, "<i>$1</i>");

  // Strikethrough
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Links [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  return result;
}

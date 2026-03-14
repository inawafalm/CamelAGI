// Block chunker: buffers streamed text into sized blocks for channels (Telegram, etc.)

export interface ChunkerOpts {
  minChars?: number;
  maxChars?: number;
  breakPreference?: "paragraph" | "newline" | "sentence";
  onChunk: (text: string) => void;
}

export class BlockChunker {
  private buffer = "";
  private minChars: number;
  private maxChars: number;
  private breakPref: "paragraph" | "newline" | "sentence";
  private onChunk: (text: string) => void;
  private inFence = false;

  constructor(opts: ChunkerOpts) {
    this.minChars = opts.minChars ?? 800;
    this.maxChars = opts.maxChars ?? 3500;
    this.breakPref = opts.breakPreference ?? "paragraph";
    this.onChunk = opts.onChunk;
  }

  append(text: string): void {
    this.buffer += text;
    this.trackFences(text);
    this.drain();
  }

  flush(): void {
    if (this.buffer.length > 0) {
      if (this.inFence) {
        this.buffer += "\n```";
        this.inFence = false;
      }
      this.onChunk(this.buffer);
      this.buffer = "";
    }
  }

  private trackFences(text: string): void {
    const fencePattern = /```/g;
    let match;
    while ((match = fencePattern.exec(text)) !== null) {
      this.inFence = !this.inFence;
    }
  }

  private drain(): void {
    while (this.buffer.length >= this.minChars) {
      if (this.inFence && this.buffer.length < this.maxChars) {
        break; // Don't break inside code fences unless forced
      }

      const breakIdx = this.pickBreakIndex();
      if (breakIdx <= 0) break;

      let chunk = this.buffer.slice(0, breakIdx);
      this.buffer = this.buffer.slice(breakIdx);

      // If we broke inside a fence, close and reopen
      const fenceCount = (chunk.match(/```/g) || []).length;
      if (fenceCount % 2 !== 0) {
        chunk += "\n```";
        this.buffer = "```\n" + this.buffer;
      }

      this.onChunk(chunk);
    }

    // Hard break at maxChars
    while (this.buffer.length > this.maxChars) {
      let chunk = this.buffer.slice(0, this.maxChars);
      this.buffer = this.buffer.slice(this.maxChars);

      const fenceCount = (chunk.match(/```/g) || []).length;
      if (fenceCount % 2 !== 0) {
        chunk += "\n```";
        this.buffer = "```\n" + this.buffer;
      }

      this.onChunk(chunk);
    }
  }

  private pickBreakIndex(): number {
    const searchRange = Math.min(this.buffer.length, this.maxChars);
    const text = this.buffer.slice(0, searchRange);

    // Try preferred break type
    if (this.breakPref === "paragraph") {
      const idx = this.findLastBreak(text, /\n\n/g);
      if (idx >= this.minChars) return idx + 2;
    }

    // Newline break
    const nlIdx = this.findLastBreak(text, /\n/g);
    if (nlIdx >= this.minChars) return nlIdx + 1;

    // Sentence break
    const sentIdx = this.findLastBreak(text, /[.!?]\s/g);
    if (sentIdx >= this.minChars) return sentIdx + 2;

    // Word break
    const wordIdx = this.findLastBreak(text, /\s/g);
    if (wordIdx >= this.minChars) return wordIdx + 1;

    // Force break at maxChars
    return searchRange >= this.maxChars ? this.maxChars : 0;
  }

  private findLastBreak(text: string, pattern: RegExp): number {
    let lastIdx = -1;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index >= this.minChars) {
        lastIdx = match.index;
      }
    }
    return lastIdx;
  }
}

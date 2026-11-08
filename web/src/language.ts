import type { Extension } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { go } from '@codemirror/lang-go';
import { cpp } from '@codemirror/lang-cpp';
import { xml } from '@codemirror/lang-xml';

/**
 * 根据文件扩展名返回对应的 CodeMirror 语言扩展。
 * 首版聚焦纯文本/代码/标记语言；Office 在后续里程碑接入。
 */
export function languageExtensionFor(filename: string): Extension[] {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';

  switch (ext) {
    case 'json':
    case 'jsonc':
      return [json()];
    case 'md':
    case 'markdown':
      return [markdown()];
    case 'html':
    case 'htm':
      return [html()];
    case 'xml':
    case 'svg':
      return [xml()];
    case 'go':
      return [go()];
    case 'cs':
      // C# 复用 C/C++ 语法高亮（首版方案，后续可替换为专用 C# 包）。
      return [cpp()];
    default:
      // txt / log / conf / ini / env / yml / yaml / toml / js / ts / css / py / sh / sql 等
      // 首版暂以纯文本呈现，语法高亮按需逐步补充。
      return [];
  }
}

/** 判断是否为 Markdown 文件（用于决定是否显示预览）。 */
export function isMarkdown(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'md' || ext === 'markdown';
}

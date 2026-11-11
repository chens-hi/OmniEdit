import type { Extension } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { go } from '@codemirror/lang-go';
import { cpp } from '@codemirror/lang-cpp';
import { xml } from '@codemirror/lang-xml';
import { javascript } from '@codemirror/lang-javascript';
import { css } from '@codemirror/lang-css';
import { python } from '@codemirror/lang-python';
import { java } from '@codemirror/lang-java';
import { rust } from '@codemirror/lang-rust';
import { php } from '@codemirror/lang-php';
import { sql } from '@codemirror/lang-sql';
import { yaml } from '@codemirror/lang-yaml';

/**
 * 语言解析器模块级单例：扩展实例在模块加载时创建一次并复用，
 * languageExtensionFor 只做查表返回——不随打开文件反复分配（性能/GC）。
 */
const LANG_JSON = json();
const LANG_MARKDOWN = markdown();
const LANG_HTML = html();
const LANG_XML = xml();
const LANG_GO = go();
const LANG_CPP = cpp();
const LANG_JS = javascript();
const LANG_TS = javascript({ typescript: true });
const LANG_JSX = javascript({ jsx: true });
const LANG_TSX = javascript({ typescript: true, jsx: true });
const LANG_CSS = css();
const LANG_PYTHON = python();
const LANG_JAVA = java();
const LANG_RUST = rust();
const LANG_PHP = php();
const LANG_SQL = sql();
const LANG_YAML = yaml();

/**
 * 根据文件扩展名返回对应的 CodeMirror 语言扩展（查表复用单例）。
 * 未匹配的类型回落纯文本（返回空数组），由编辑器外壳主题保证深浅观感。
 */
export function languageExtensionFor(filename: string): Extension[] {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';

  switch (ext) {
    // 数据 / 配置
    case 'json':
    case 'jsonc':
      return [LANG_JSON];
    case 'yml':
    case 'yaml':
      return [LANG_YAML];
    // 标记
    case 'md':
    case 'markdown':
      return [LANG_MARKDOWN];
    case 'html':
    case 'htm':
      return [LANG_HTML];
    case 'xml':
    case 'svg':
      return [LANG_XML];
    // 样式
    case 'css':
    case 'scss':
    case 'less':
      return [LANG_CSS];
    // 脚本 / 编程
    case 'js':
    case 'mjs':
    case 'cjs':
      return [LANG_JS];
    case 'ts':
      return [LANG_TS];
    case 'jsx':
      return [LANG_JSX];
    case 'tsx':
      return [LANG_TSX];
    case 'py':
      return [LANG_PYTHON];
    case 'go':
      return [LANG_GO];
    case 'java':
      return [LANG_JAVA];
    case 'rs':
      return [LANG_RUST];
    case 'php':
      return [LANG_PHP];
    case 'c':
    case 'h':
    case 'cpp':
    case 'hpp':
    case 'cc':
      return [LANG_CPP];
    case 'cs':
      // C# 复用 C/C++ 语法（首版方案，后续可替换专用包）。
      return [LANG_CPP];
    case 'sql':
      return [LANG_SQL];
    default:
      // txt / log / conf / ini / env / toml / sh 等纯文本呈现。
      return [];
  }
}

/** 判断是否为 Markdown 文件（用于决定是否显示预览）。 */
export function isMarkdown(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'md' || ext === 'markdown';
}

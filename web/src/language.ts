import type { Extension } from '@codemirror/state';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { perl } from '@codemirror/legacy-modes/mode/perl';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { groovy } from '@codemirror/legacy-modes/mode/groovy';
import { r } from '@codemirror/legacy-modes/mode/r';
import { julia } from '@codemirror/legacy-modes/mode/julia';
import { haskell } from '@codemirror/legacy-modes/mode/haskell';
import { erlang } from '@codemirror/legacy-modes/mode/erlang';
import { clojure } from '@codemirror/legacy-modes/mode/clojure';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { nginx } from '@codemirror/legacy-modes/mode/nginx';
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf';
import { diff } from '@codemirror/legacy-modes/mode/diff';
import { coffeeScript } from '@codemirror/legacy-modes/mode/coffeescript';
import { vb } from '@codemirror/legacy-modes/mode/vb';
import { vbScript } from '@codemirror/legacy-modes/mode/vbscript';
import { pascal } from '@codemirror/legacy-modes/mode/pascal';
import { gas } from '@codemirror/legacy-modes/mode/gas';
import { cmake } from '@codemirror/legacy-modes/mode/cmake';
import { scheme } from '@codemirror/legacy-modes/mode/scheme';
import { tcl } from '@codemirror/legacy-modes/mode/tcl';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { kotlin as clikeKotlin, scala as clikeScala, dart as clikeDart } from '@codemirror/legacy-modes/mode/clike';
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
// Shell 走 legacy stream-parser（CM6 无官方 lang-shell），用 StreamLanguage 包装。
const LANG_SHELL = StreamLanguage.define(shell);
const LANG_RUBY = StreamLanguage.define(ruby);
const LANG_LUA = StreamLanguage.define(lua);
const LANG_PERL = StreamLanguage.define(perl);
const LANG_POWERSHELL = StreamLanguage.define(powerShell);
const LANG_SWIFT = StreamLanguage.define(swift);
const LANG_GROOVY = StreamLanguage.define(groovy);
const LANG_R = StreamLanguage.define(r);
const LANG_JULIA = StreamLanguage.define(julia);
const LANG_HASKELL = StreamLanguage.define(haskell);
const LANG_ERLANG = StreamLanguage.define(erlang);
const LANG_CLOJURE = StreamLanguage.define(clojure);
const LANG_DOCKERFILE = StreamLanguage.define(dockerFile);
const LANG_TOML = StreamLanguage.define(toml);
const LANG_PROPERTIES = StreamLanguage.define(properties);
const LANG_NGINX = StreamLanguage.define(nginx);
const LANG_PROTOBUF = StreamLanguage.define(protobuf);
const LANG_DIFF = StreamLanguage.define(diff);
const LANG_COFFEESCRIPT = StreamLanguage.define(coffeeScript);
const LANG_VB = StreamLanguage.define(vb);
const LANG_VBSCRIPT = StreamLanguage.define(vbScript);
const LANG_PASCAL = StreamLanguage.define(pascal);
const LANG_GAS = StreamLanguage.define(gas);
const LANG_CMAKE = StreamLanguage.define(cmake);
const LANG_SCHEME = StreamLanguage.define(scheme);
const LANG_TCL = StreamLanguage.define(tcl);
const LANG_STEX = StreamLanguage.define(stex);
// clike 系（Kotlin/Scala/Dart）使用 clike 模块的预设导出
const LANG_KOTLIN = StreamLanguage.define(clikeKotlin);
const LANG_SCALA = StreamLanguage.define(clikeScala);
const LANG_DART = StreamLanguage.define(clikeDart);

/**
 * 根据文件扩展名返回对应的 CodeMirror 语言扩展（查表复用单例）。
 * 未匹配的类型回落纯文本（返回空数组），由编辑器外壳主题保证深浅观感。
 */
export function languageExtensionFor(filename: string): Extension[] {
  // 无扩展名的特殊文件名优先匹配（Dockerfile / Makefile 等）
  const base = filename.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (base === 'dockerfile') return [LANG_DOCKERFILE];
  if (base === 'cmakelists.txt') return [LANG_CMAKE];

  const ext = filename.split('.').pop()?.toLowerCase() ?? '';

  switch (ext) {
    // 数据 / 配置
    case 'json':
    case 'jsonc':
    case 'json5':
    case 'webmanifest':
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
    case 'wxs':
    case 'wxi':
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
    case 'sh':
    case 'bash':
    case 'zsh':
      return [LANG_SHELL];
    case 'rb':
      return [LANG_RUBY];
    case 'lua':
      return [LANG_LUA];
    case 'pl':
    case 'pm':
      return [LANG_PERL];
    case 'ps1':
    case 'psm1':
    case 'psd1':
      return [LANG_POWERSHELL];
    // ---- 新增：补齐常见编程语言与配置格式 ----
    // 移动 / Apple
    case 'swift':
      return [LANG_SWIFT];
    case 'kt':
    case 'kts':
      return [LANG_KOTLIN];
    case 'dart':
      return [LANG_DART];
    // JVM
    case 'scala':
      return [LANG_SCALA];
    case 'groovy':
    case 'gvy':
      return [LANG_GROOVY];
    case 'clj':
    case 'cljs':
    case 'edn':
      return [LANG_CLOJURE];
    // 函数式 / 系统
    case 'hs':
    case 'lhs':
      return [LANG_HASKELL];
    case 'erl':
    case 'hrl':
      return [LANG_ERLANG];
    case 'jl':
      return [LANG_JULIA];
    case 'r':
      return [LANG_R];
    case 'scm':
    case 'ss':
      return [LANG_SCHEME];
    case 'tcl':
      return [LANG_TCL];
    // 数据 / 配置
    case 'toml':
      return [LANG_TOML];
    case 'ini':
    case 'cfg':
    case 'properties':
    case 'env':
    case 'editorconfig':
    case 'gitconfig':
    case 'npmrc':
    case 'yarnrc':
    case 'service':
    case 'timer':
    case 'socket':
    case 'desktop':
      return [LANG_PROPERTIES];
    case 'conf':
    case 'nginx':
      return [LANG_NGINX];
    case 'proto':
      return [LANG_PROTOBUF];
    case 'cmake':
    case 'cmakelists':
      return [LANG_CMAKE];
    case 'dockerfile':
      return [LANG_DOCKERFILE];
    // 标记 / 差异
    case 'diff':
    case 'patch':
      return [LANG_DIFF];
    // 脚本
    case 'coffee':
      return [LANG_COFFEESCRIPT];
    case 'vb':
      return [LANG_VB];
    case 'vbs':
      return [LANG_VBSCRIPT];
    case 'pas':
    case 'dpr':
      return [LANG_PASCAL];
    // 底层
    case 's':
    case 'asm':
      return [LANG_GAS];
    // 脚本 / 配置补充
    case 'bat':
    case 'cmd':
      // Windows 批处理：无专用 mode，用 shell 近似（高亮注释/字符串/数字）
      return [LANG_SHELL];
    case 'reg':
      // Windows 注册表导出：格式与 INI/properties 一致
      return [LANG_PROPERTIES];
    case 'tex':
    case 'latex':
      return [LANG_STEX];
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

/**
 * 预览渲染类型（多后缀共用一个渲染模板）：
 *   - md / markdown → 'markdown'（同一 Markdown 渲染器）
 *   - htm / html → 'html'（同一 iframe 渲染器）
 *   - 其它 → null（无预览）
 */
export function previewKind(filename: string): 'markdown' | 'html' | null {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'htm':
    case 'html':
      return 'html';
    default:
      return null;
  }
}

/**
 * 预览内容上限（1 MB）：超过则预览显示「内容过大」提示，不渲染。
 * 预览是全量 DOM 渲染（非编辑器的视口增量），>1MB 单次更新会阻塞主线程
 * 数百毫秒且内存放大数十倍；编辑阈值（10MB）与预览阈值分开，各管各的。
 */
export const PREVIEW_MAX_BYTES = 1 << 20;

/**
 * 可打开/可编辑的文件扩展名（小写，不含点）——这是**能力全集**。
 *
 * 与 ui/config 的 fileTypes（注册列表）是**两个独立概念**：
 *   - REGISTERED_EXTENSIONS：给飞牛看的，决定文件管理器右键菜单是否出现
 *     OmniEdit。飞牛对数量有未公开上限（实测 93 个会失败），所以必须精简。
 *   - SUPPORTED_EXTENSIONS（本变量）：给自己看的，决定应用内哪些文件能打开。
 *     不受平台限制，应当覆盖全部有语法高亮的格式。
 *
 * 两者关系：REGISTERED ⊂ SUPPORTED。注册少只意味着「右键菜单不显示」，
 * 用户仍可通过应用内「打开」菜单输入路径打开任意受支持的格式。
 *
 * 与 languageExtensionFor 的 switch case 保持同步——新增语言时两处都要补。
 */
export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
  // ---- 配置 / 数据 ----
  'json', 'jsonc', 'json5', 'webmanifest',
  'yml', 'yaml', 'toml',
  'ini', 'cfg', 'conf', 'env', 'properties',
  'editorconfig', 'gitconfig', 'npmrc', 'yarnrc',
  'dockerfile', 'nginx', 'proto', 'cmake', 'cmakelists',
  'xml', 'svg', 'wxs', 'wxi',
  'diff', 'patch',
  'service', 'timer', 'socket', 'desktop',
  // ---- 标记 / 文档 / 样式 ----
  'md', 'markdown', 'html', 'htm',
  'css', 'scss', 'less',
  'txt', 'log',
  // ---- 主流编程语言 ----
  'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx',
  'py', 'go', 'java', 'cs', 'rs', 'php', 'rb',
  'c', 'h', 'cpp', 'hpp', 'cc',
  'sh', 'bash', 'zsh', 'ps1', 'psm1', 'psd1', 'bat', 'cmd',
  'sql', 'lua', 'pl', 'pm',
  'swift', 'kt', 'kts', 'dart', 'scala', 'groovy', 'gvy',
  // ---- 其他已支持高亮的语言 ----
  'r', 'jl', 'hs', 'lhs', 'erl', 'hrl',
  'clj', 'cljs', 'edn', 'coffee',
  'vb', 'vbs', 'pas', 'dpr',
  's', 'asm', 'tcl', 'scm', 'ss',
  'tex', 'latex', 'reg',
]);

/**
 * 显式标记为「不适合编辑」的二进制/容器格式：直接拒绝，避免当文本读出乱码。
 * 这些不在 SUPPORTED_EXTENSIONS 里，此处单列是为了给出更准确的提示文案，
 * 而不是笼统的「不支持的格式」。
 */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // Office / 文档容器
  'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'pdf',
  // 压缩包
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz',
  // 图片
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'tiff', 'psd',
  // 音视频
  'mp3', 'mp4', 'avi', 'mkv', 'mov', 'wav', 'flac', 'webm',
  // 可执行 / 库
  'exe', 'dll', 'so', 'dylib', 'bin', 'iso', 'dmg', 'msi', 'deb', 'rpm',
  // 其他
  'class', 'jar', 'war', 'pyc', 'o', 'a', 'obj', 'ttf', 'otf', 'woff', 'woff2',
]);

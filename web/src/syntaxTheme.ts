import type { Extension } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Theme } from './theme';

/**
 * 语法高亮配色（由应用自身主题派生，不参考外部主题）。
 *
 * 设计：
 *   - 以应用主题 token（accent 蓝 / success 绿 / warning 橙 / error 红 / fg / fg-muted）为锚，
 *     为每个语法角色取同族、彼此可区分的色；暗色端提亮、浅色端加深保证对比度。
 *   - 为 dark / light 各定义一份 HighlightStyle，并按主题缓存（define 只做一次，
 *     避免反复分配）；syntaxHighlightFor(theme) 命中缓存直接返回。
 *   - 解析器（language.ts）只负责结构，配色全部由这里的 HighlightStyle 统一控制。
 */

interface TokenPalette {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  type: string;
  fn: string;
  variable: string;
  property: string;
  operator: string;
  punctuation: string;
  constant: string;
  tag: string;
  attribute: string;
  meta: string;
  heading: string;
  link: string;
}

// 暗色（#1e1e1e 底）：从 accent/success/warning/error 派生并提亮。
const DARK: TokenPalette = {
  keyword: '#6cb6ff',   // accent 蓝提亮
  string: '#6fd3c1',    // success 青绿提亮
  number: '#e2c08d',    // warning 橙
  comment: '#7a7a7a',   // fg-muted 灰
  type: '#56c8b0',      // success 青派生
  fn: '#d7ba7d',        // warning 暖黄派生
  variable: '#9ecbff',  // accent 派生浅蓝
  property: '#9ecbff',
  operator: '#d4d4d4',  // fg
  punctuation: '#8b8b8b', // fg-muted
  constant: '#ff9db3',  // error 红派生
  tag: '#6cb6ff',
  attribute: '#d7ba7d',
  meta: '#d4d4d4',
  heading: '#6cb6ff',
  link: '#6fd3c1',
};

// 浅色（#ffffff 底）：对应加深保证对比度。
const LIGHT: TokenPalette = {
  keyword: '#0550ae',   // accent 蓝加深
  string: '#0a7d6b',    // success 青绿加深
  number: '#9a6700',    // warning 橙加深
  comment: '#6e7781',   // fg-muted 灰
  type: '#0a7d6b',
  fn: '#8a5a00',
  variable: '#0550ae',
  property: '#0550ae',
  operator: '#24292e',  // fg
  punctuation: '#57606a',
  constant: '#cf222e',  // error 红
  tag: '#0550ae',
  attribute: '#8a5a00',
  meta: '#24292e',
  heading: '#0550ae',
  link: '#0a7d6b',
};

function paletteFor(theme: Theme): TokenPalette {
  return theme === 'light' ? LIGHT : DARK;
}

/** 按主题缓存 HighlightStyle，避免重复 define 分配。 */
const cache = new Map<Theme, Extension>();

export function syntaxHighlightFor(theme: Theme): Extension {
  const hit = cache.get(theme);
  if (hit) return hit;
  const p = paletteFor(theme);
  const style = HighlightStyle.define([
    { tag: t.keyword, color: p.keyword },
    { tag: t.string, color: p.string },
    { tag: t.number, color: p.number },
    { tag: t.comment, color: p.comment, fontStyle: 'italic' },
    { tag: [t.typeName, t.className, t.namespace], color: p.type },
    // function/constant 是修饰函数 (tag)=>Tag，需传入具体 tag
    { tag: t.function(t.variableName), color: p.fn },
    { tag: t.variableName, color: p.variable },
    { tag: t.propertyName, color: p.property },
    { tag: t.operator, color: p.operator },
    { tag: t.punctuation, color: p.punctuation },
    { tag: [t.bool, t.null], color: p.keyword },
    { tag: t.tagName, color: p.tag },
    { tag: t.attributeName, color: p.attribute },
    { tag: t.meta, color: p.meta },
    { tag: t.heading, color: p.heading, fontWeight: 'bold' },
    { tag: t.link, color: p.link },
    { tag: t.regexp, color: p.constant },
  ]);
  const ext = syntaxHighlighting(style);
  cache.set(theme, ext);
  return ext;
}

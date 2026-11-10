<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { sdk, readFile } from '../api';
import { t } from '../i18n';
import AppModal from './AppModal.vue';

/**
 * 另存为模态对话框（替换 window.prompt）。
 *  - 保存位置：宿主 pickUserFile 选目录（dev 降级 prompt）；记忆上次目录；
 *  - 文件名：主名 + 扩展名下拉；非法字符校验；存在性预检提示覆盖。
 * 确认后 emit('confirm', fullPath)；取消 emit('close')。
 */

const props = defineProps<{
  suggestedName: string;   // 预填文件名（如 "无标题" 或 "note.md"）
  initialDir: string;      // 上次保存目录（可为空）
  /** 场景：draft = 无标题草稿首次保存（"保存为"）；copy = 已有文件另存副本（"另存为"） */
  mode: 'draft' | 'copy';
}>();

const emit = defineEmits<{
  (e: 'confirm', fullPath: string): void;
  (e: 'close'): void;
}>();

const titleText = computed(() => (props.mode === 'draft' ? t('saveAsDraftTitle') : t('saveAsCopyTitle')));

const dir = ref(props.initialDir);
const baseName = ref('');
const ext = ref('.txt');
const customExt = ref('');
const useCustomExt = ref(false);
const error = ref('');
const existsHint = ref(false);
const busy = ref(false);
const nameInput = ref<HTMLInputElement | null>(null);

const EXT_OPTIONS = ['.txt', '.md', '.yml', '.yaml', '.json', '.sh', '.py', '.js', '.html', '.css'];

// 拆分建议名：主名 + 扩展名
onMounted(() => {
  const name = props.suggestedName || t('untitled');
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    baseName.value = name.slice(0, dot);
    const e = name.slice(dot).toLowerCase();
    if (EXT_OPTIONS.includes(e)) {
      ext.value = e;
    } else {
      ext.value = '';
      useCustomExt.value = true;
      customExt.value = e;
    }
  } else {
    baseName.value = name;
  }
  void nextTick(() => {
    nameInput.value?.focus();
    nameInput.value?.select(); // 选中主名（含 rangeEnd 默认到末尾，主名即全部）
  });
  void checkExists();
  document.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
});

const fullExt = computed(() => (useCustomExt.value ? customExt.value : ext.value).trim());
const fullName = computed(() => baseName.value.trim() + fullExt.value);
const fullPath = computed(() => joinPath(dir.value, fullName.value));

function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const sep = /^[a-zA-Z]:[\\/]/.test(dir) || dir.includes('\\') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name.replace(/^[\\/]+/, '');
}

/** 非法文件名字符校验（路径分隔符与控制符）。 */
function invalidChars(name: string): boolean {
  return /[\\/\0]/.test(name) || /[\x00-\x1f]/.test(name);
}

/** 存在性预检：目标可读即视为已存在（将覆盖）。 */
async function checkExists() {
  existsHint.value = false;
  if (!dir.value || !fullName.value || baseName.value.trim() === '') return;
  try {
    await readFile(joinPath(dir.value, fullName.value));
    existsHint.value = true;
  } catch {
    existsHint.value = false; // 404/403 均视为不存在（403 在 root 模式下罕见）
  }
}

async function chooseDir() {
  if (sdk.isStandaloneWeb) {
    const d = window.prompt(t('promptDir'), dir.value);
    if (d) { dir.value = d; void checkExists(); }
    return;
  }
  try {
    const res = await sdk.pickUserFile({
      directory: true,
      creatable: true,
      title: t('pickDirTitle'),
      okText: t('pickDirOk'),
      sidebarGroup: ['myFiles', 'otherShare', 'favorites'],
    });
    const picked = extractDir(res);
    if (picked) { dir.value = picked; void checkExists(); }
    else console.warn('[SaveAsDialog] 宿主选择器返回无法解析:', JSON.stringify(res));
  } catch (err) {
    console.warn('[SaveAsDialog] 宿主选择器异常:', err);
  }
}

/**
 * 从宿主选择器响应中提取目录路径。
 * 真机实测（v0.2.1 反馈）：返回形状存在多种可能——
 *   AppBridgeResponse<string[]> 官方契约之外，实际宿主可能返回：
 *   { code:0, data:"/vol1/x" }（单字符串）、{ data:{path:"..."} }、
 *   { data:{paths:[...]} }、直接返回字符串/数组本身。
 * 统一做深形状自适应，任何可辨认形态都提取出第一个路径。
 */
function extractDir(res: unknown): string | null {
  if (!res) return null;
  // 直接字符串
  if (typeof res === 'string') return res;
  const r = res as Record<string, unknown>;
  // 深入 data / result 包装
  const candidates: unknown[] = [r.data, r.result, r];
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const first = c.find((x): x is string => typeof x === 'string' && x.length > 0);
      if (first) return first;
      // 数组内对象：{path}
      for (const item of c) {
        if (item && typeof item === 'object') {
          const p = (item as Record<string, unknown>).path;
          if (typeof p === 'string' && p) return p;
        }
      }
    } else if (typeof c === 'object') {
      const obj = c as Record<string, unknown>;
      for (const key of ['path', 'dir', 'folder', 'filePath', 'selectedPath']) {
        if (typeof obj[key] === 'string' && obj[key] as string) return obj[key] as string;
      }
      // {paths:[...]} / {list:[...]}
      for (const key of ['paths', 'list', 'items']) {
        const arr = obj[key];
        if (Array.isArray(arr)) {
          const first = arr.find((x): x is string => typeof x === 'string' && x.length > 0);
          if (first) return first;
        }
      }
    }
  }
  return null;
}

function confirm() {
  error.value = '';
  if (dir.value.trim() === '') { error.value = t('errNeedDir'); return; }
  if (baseName.value.trim() === '') { error.value = t('errNeedName'); return; }
  if (invalidChars(baseName.value) || invalidChars(fullExt.value)) {
    error.value = t('invalidName');
    return;
  }
  let e = fullExt.value;
  if (e && !e.startsWith('.')) e = '.' + e;
  emit('confirm', joinPath(dir.value, baseName.value.trim() + e));
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') { e.preventDefault(); confirm(); }
  else if (e.key === 'Escape') { e.preventDefault(); emit('close'); }
}
</script>

<template>
  <AppModal :title="titleText" :width="480" @close="emit('close')">
    <div class="sad-body">
      <label class="sad-label">{{ t('saveLocation') }}</label>
      <div class="sad-dir-row">
        <input
          class="sad-dir"
          :value="dir"
          :placeholder="t('saveLocation')"
          readonly
        />
        <button class="sad-btn ghost" @click="chooseDir">{{ t('choose') }}</button>
      </div>

      <label class="sad-label">{{ t('fileName') }}</label>
      <div class="sad-name-row">
        <input
          ref="nameInput"
          v-model="baseName"
          class="sad-input sad-base"
          :placeholder="t('fileName')"
          spellcheck="false"
          @input="checkExists"
        />
        <select
          v-if="!useCustomExt"
          v-model="ext"
          class="sad-input sad-ext"
          @change="checkExists"
        >
          <option v-for="e in EXT_OPTIONS" :key="e" :value="e">{{ e }}</option>
          <option value="">自定义…</option>
        </select>
        <input
          v-else
          v-model="customExt"
          class="sad-input sad-ext"
          placeholder=".ext"
          spellcheck="false"
          @change="checkExists"
        />
      </div>

      <div v-if="error" class="sad-error">{{ error }}</div>
      <div v-else-if="existsHint" class="sad-hint">ⓘ {{ t('overwriteHint') }}</div>
      <div class="sad-fullpath" :title="fullPath">{{ fullPath }}</div>
    </div>

    <template #footer>
      <button class="sad-btn ghost" @click="emit('close')">{{ t('cancel') }}</button>
      <button class="sad-btn primary" :disabled="busy" @click="confirm">{{ t('saveBtn') }}</button>
    </template>
  </AppModal>
</template>

<style scoped>
/* 卡片骨架（遮罩/标题栏/底部条/关闭按钮）由 AppModal 提供，这里只保留表单内容样式。 */
.sad-body { display: flex; flex-direction: column; gap: 6px; }
.sad-label { font-size: 12px; color: var(--fg-muted); margin-top: 4px; }

.sad-dir-row, .sad-name-row { display: flex; gap: 6px; }
.sad-dir {
  flex: 1; padding: 6px 8px;
  border: 1px solid var(--border); border-radius: 4px;
  background: color-mix(in srgb, var(--fg) 3%, transparent); color: var(--fg);
  font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sad-input {
  padding: 6px 8px;
  border: 1px solid var(--border); border-radius: 4px;
  background: var(--bg); color: var(--fg); font-size: 12px; outline: none;
}
.sad-input:focus { border-color: var(--accent); }
.sad-base { flex: 1; }
.sad-ext { width: 90px; flex-shrink: 0; }

.sad-error { font-size: 12px; color: var(--error); }
.sad-hint { font-size: 12px; color: color-mix(in srgb, var(--accent) 70%, var(--fg)); }
.sad-fullpath {
  font-size: 11px; color: var(--fg-muted); font-family: var(--font-mono);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  margin-top: 2px;
}

.sad-btn {
  padding: 6px 16px; border-radius: 6px; font-size: 12px; cursor: pointer;
  border: 1px solid var(--border); background: transparent; color: var(--fg);
}
.sad-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.sad-btn.primary:hover { filter: brightness(1.1); }
.sad-btn.ghost:hover { border-color: var(--accent); color: var(--accent); }
</style>

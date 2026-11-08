package ws

import "testing"

// TestComputeAccept_RFC6455Example 用 RFC 6455 规范里的示例向量校验握手算法。
// 规范：key="dGhlIHNhbXBsZSBub25jZQ==" → accept="s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
func TestComputeAccept_RFC6455Example(t *testing.T) {
	const key = "dGhlIHNhbXBsZSBub25jZQ=="
	const want = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
	if got := computeAccept(key); got != want {
		t.Errorf("computeAccept(%q) = %q，期望 %q", key, got, want)
	}
}

// TestComputeAccept_Deterministic 同一 key 多次计算结果应一致。
func TestComputeAccept_Deterministic(t *testing.T) {
	a := computeAccept("some-random-key")
	b := computeAccept("some-random-key")
	if a != b {
		t.Errorf("computeAccept 应确定性输出，实际 %q vs %q", a, b)
	}
	if len(a) != 28 { // base64(sha1) 固定 28 字符
		t.Errorf("accept 长度应为 28，实际 %d", len(a))
	}
}

// TestComputeAccept_DifferentKeys 不同 key 应产生不同 accept。
func TestComputeAccept_DifferentKeys(t *testing.T) {
	if computeAccept("key-one") == computeAccept("key-two") {
		t.Error("不同 key 不应产生相同 accept")
	}
}

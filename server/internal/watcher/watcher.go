// Package watcher 通过轮询 mtime 检测文件的外部变更。
//
// 设计取舍：不引入 fsnotify 等第三方依赖，保持后端纯标准库、可交叉编译
// （linux/amd64 + linux/arm64）。轮询对「编辑器检测当前打开文件是否被外部
// 修改」这一场景足够：只轮询已打开的少量文件，间隔数秒，开销可忽略。
package watcher

import (
	"os"
	"sync"
	"time"
)

// Event 一次外部变更事件。
type Event struct {
	Path   string `json:"path"`
	MTime  string `json:"mtime"`  // 新的 mtime（RFC3339Nano）
	Reason string `json:"reason"` // modified | deleted
}

// Watcher 轮询一组文件路径的 mtime。
type Watcher struct {
	mu       sync.Mutex
	mtimes   map[string]string // path -> 上次已知 mtime
	interval time.Duration
	stop     chan struct{}
	events   chan Event
	once     sync.Once
}

// New 创建轮询 watcher。interval 为轮询间隔（建议 2~5s）。
func New(interval time.Duration) *Watcher {
	return &Watcher{
		mtimes:   make(map[string]string),
		interval: interval,
		stop:     make(chan struct{}),
		events:   make(chan Event, 64),
	}
}

// Events 返回变更事件通道（只读）。
func (w *Watcher) Events() <-chan Event {
	return w.events
}

// Watch 注册/更新一个受监控文件，并以当前 mtime 作为基线（不触发事件）。
func (w *Watcher) Watch(path string) {
	mt := currentMTime(path)
	w.mu.Lock()
	w.mtimes[path] = mt
	w.mu.Unlock()
}

// Unwatch 取消监控某文件。
func (w *Watcher) Unwatch(path string) {
	w.mu.Lock()
	delete(w.mtimes, path)
	w.mu.Unlock()
}

// Watching 报告某文件当前是否处于监控中（供测试与状态诊断使用）。
func (w *Watcher) Watching(path string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	_, ok := w.mtimes[path]
	return ok
}

// Start 启动轮询循环（非阻塞）。重复调用无害。
func (w *Watcher) Start() {
	w.once.Do(func() {
		go w.loop()
	})
}

// Stop 停止轮询循环。
func (w *Watcher) Stop() {
	select {
	case <-w.stop:
	default:
		close(w.stop)
	}
}

func (w *Watcher) loop() {
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for {
		select {
		case <-w.stop:
			return
		case <-ticker.C:
			w.poll()
		}
	}
}

// poll 比对每个受监控文件的当前 mtime 与基线，发出变更事件并更新基线。
func (w *Watcher) poll() {
	w.mu.Lock()
	defer w.mu.Unlock()
	for path, known := range w.mtimes {
		cur := currentMTime(path)
		if cur == known {
			continue
		}
		reason := "modified"
		if cur == "" {
			reason = "deleted"
		}
		w.mtimes[path] = cur
		ev := Event{Path: path, MTime: cur, Reason: reason}
		// 非阻塞发送：通道满则丢弃（避免慢消费者阻塞轮询）。
		select {
		case w.events <- ev:
		default:
		}
	}
}

// currentMTime 返回文件 mtime（RFC3339Nano）；不存在或不可读返回空串。
func currentMTime(path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return ""
	}
	return info.ModTime().Format(time.RFC3339Nano)
}

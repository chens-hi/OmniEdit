# Markdown 相对图片测试

## 1. 同目录相对路径

![相对图片](images/logo.png)

能看到蓝底白圆 = Markdown 的相对图片也走了重写。

## 2. data URI

![data svg](data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='80'%3E%3Crect width='120' height='80' fill='%23cf222e'/%3E%3C/svg%3E)

红块 = data URI 直通正常。

## 3. 链接指向文件

[打开 logo.png](images/logo.png) —— 点击应在新窗口显示图片（重写后走 raw 接口）。

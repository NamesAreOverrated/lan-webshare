# 局域网笔记

一个支持局域网协作、WebSocket 实时同步、Markdown 编辑与文件共享的小工具。

## 功能概览
- 分组/标签管理，条目创建、克隆、拖拽排序、实时同步
- EasyMDE Markdown 编辑器，状态栏字数与保存提示
- 文件上传与下载
- 一键导出整组为 Markdown

## 快速开始
1. 安装依赖
   npm install

2. 启动服务
   npm start

3. 打开浏览器访问
   http://localhost:3000

可通过环境变量 PORT 指定端口，例如：
  PORT=4000 npm start

## 目录结构
- server.js: Node/Express + WebSocket 服务
- public/: 前端静态资源
  - index.html: 页面结构
  - style.css: 样式
  - app.js: 应用逻辑（由 index.html 内联脚本抽离）
- uploads/: 上传目录（自动创建，已加入 .gitignore）
- db.json: 数据存储（自动创建，已加入 .gitignore）

## 许可
ISC

# 局域网笔记与文件分享（lan-webshare）

一个在局域网内使用的 Markdown 笔记与文件分享小工具。后端基于 Node.js + Express + WebSocket，前端使用 Tailwind CSS、EasyMDE（Markdown 编辑器）与 SortableJS（拖拽排序）。数据持久化到 db.json，上传文件保存在 uploads 目录。

## 功能特性
- 笔记分组与标签
- 条目：新建、编辑、删除、克隆、拖拽排序、标题与内容搜索
- 多端实时同步（WebSocket），编辑中远端更新提示，并可一键“应用”
- 文件：上传、列表、下载（变更自动广播刷新）
- 一键导出：将某个分组导出为一个 Markdown 文件
- 响应式布局与移动端优化

## 目录结构
- server.js：服务端与 WebSocket 同步逻辑
- public/
  - index.html：前端页面与逻辑
  - style.css：样式与编辑器适配
- uploads/：上传文件目录（启动时若不存在自动创建）
- db.json：数据文件（首次启动自动创建）

## 快速开始
1. 环境要求：Node.js 18+（推荐 LTS）
2. 安装依赖：
   - npm install
3. 启动服务：
   - node server.js
4. 访问：
   - 浏览器打开 http://localhost:3000
   - 控制台会打印局域网可访问地址，例如 http://192.168.x.x:3000

提示：默认端口为 3000，如需更改，请修改 server.js 中的 PORT 常量。

## 使用说明
- 左侧侧边栏包含两个标签：
  - 笔记：新建/编辑分组与标签，选择分组后管理条目
  - 文件：选择文件上传，上传后可在列表中下载
- 顶部栏：在条目编辑时可直接修改标题；在分组列表视图可“导出”和“新建”。
- 条目列表：
  - 空列表时：点击列表空白区域即可“隐式新建条目”（插入到列表最前）
  - 有条目时：每条右侧有“插入”按钮，点击可选择“上/下”，在该条目前/后插入新条目
  - 支持标题搜索与拖拽排序（抓住左侧把手）
  - 支持克隆条目（在原条目后插入副本）
- 编辑器：
  - Markdown 编辑（EasyMDE），状态栏展示字数、光标位置、保存时间与远端冲突提示
  - 编辑内容与标题自动节流保存（约 500ms）

## HTTP 接口
- GET /files：返回已上传文件名的 JSON 数组
- POST /upload：表单上传文件（字段名 file），成功后重定向到首页
- GET /uploads/:filename：静态文件下载
- GET /export?groupId=...：导出指定分组为 .md 文件

## 数据与备份
- 数据文件：项目根目录下的 db.json，会在首次启动时自动创建
- 上传目录：uploads/，按原文件名（带时间戳前缀）保存
- 备份建议：定期备份 db.json 与 uploads 目录
- 清空数据：停止服务后删除 db.json 与 uploads 内文件，然后重新启动
- 安全说明：项目未实现鉴权与权限控制，仅适用于可信的局域网环境

## 开发提示
- WebSocket 消息类型：
  - 客户端 -> 服务端：create_group、update_group、delete_group、create_entry、update_entry、delete_entry、clone_entry、reorder_entries、insert_entry
  - 服务端 -> 客户端：full_sync（包含全部数据）、files_updated（文件有更新）
- 任何一端修改数据后，服务器会持久化到 db.json 并广播 full_sync，前端据此更新 UI

## 常见问题
- 端口占用：修改 server.js 中的 PORT，或释放占用端口
- 文件名乱码：已按 UTF-8 处理上传文件名
- 移动端 100vh 问题：已通过 CSS 变量与 100dvh 适配

## 许可
本项目使用 ISC 许可协议。

<h1 align="center">CoTeam</h1>

<p align="center"><sub><strong>简体中文</strong> · <a href="./README.en.md">English</a></sub></p>

<p align="center">
  <strong>团队一起用的 AI 编程工作台</strong><br/>
  智能体跑在团队的服务器上，你在自己的 Mac 上看、聊、接手。
</p>

<h3 align="center"><a href="https://github.com/Tinghecui/dodoer-releases/releases/latest/download/dodoer-macos-arm64.zip"><ins>下载 macOS 版（Apple 芯片）</ins></a> · <a href="https://github.com/Tinghecui/dodoer-releases/releases"><ins>所有版本</ins></a></h3>

## 能做什么

- **一个界面用所有智能体**：Claude Code、Codex 等都在同一个对话窗口里，工具调用、改动的文件、diff 一目了然。
- **本机和服务器同时开**：开始页选「在这台电脑上工作」或者一台服务器，几个窗口可以同时开着。
- **把这台 Mac 借给服务器上的智能体**：让它用你的 Chrome 打开网页、在你的电脑上跑命令，随时一键收回。
- **自动更新**：有新版本时 app 里会提示，点更新、重启就好。

## 安装

1. 下载上面的安装包，解压，把 `dodoer.app` 拖进「应用程序」。
2. 第一次打开前，在终端执行一次：

   ```bash
   xattr -dr com.apple.quarantine /Applications/dodoer.app
   ```

   （现在的安装包还没有 Apple 开发者签名，不执行这一步 macOS 会拦着不让打开。）
3. 打开 app，在开始页选「在这台电脑上工作」，或者连团队的服务器（见下）。

> 装好以后 app 在「应用程序」里暂时还叫 dodoer，这是旧名字，以后的版本会改。

## 连团队的服务器

在团队门户「我的账户」→「桌面版」里点「在桌面 app 里打开」，app 会问一句，确认后自动连上，不用手动填地址和令牌。

## 这个仓库是什么

这里是 CoTeam 桌面版和服务端的**发布仓库**：每个版本的安装包、更新清单都发在 [Releases](https://github.com/Tinghecui/dodoer-releases/releases) 里。
仓库里的代码是从开发仓库自动同步过来的，用来在公开的机器上跑测试和打包；开发不在这里进行，这里的提交和 PR 不会被合并。

- `v1.x.y`：桌面版
- `cowork-codeg-vX.Y.Z`：服务端（由团队服务器的管理员在门户里升级）

## 致谢和许可

CoTeam 基于开源项目 [Codeg](https://github.com/spacering-net/codeg) 和它的分支 dodoer 开发，感谢两边的作者。
按 [Apache License 2.0](./LICENSE) 发布。

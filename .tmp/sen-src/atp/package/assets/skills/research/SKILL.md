---
name: research
description: 当需要针对高可信一手来源调研问题、收集文档或 API 事实，或把阅读工作交给成员时使用。给出可核查的结论与证据边界。
---

Spin up a **background agent** to do the research, so you keep working while it reads.

Its job:

1. Investigate the question against **primary sources** (official docs, source code, specs, first-party APIs), not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.

## 在 DSH 团队中的用法

本节为 DSH 适配说明；与上文英文原文冲突时，以本节为准。

- 优先一手来源：官方文档、源码、规范、一方 API；二手文章只用于定位线索。
- 自己能查的直接查；只有在工具允许且委派有实际收益时才交给其他成员。
- 需要委派时先取得团队规则或用户授权，不自行召唤成员。
- 每条重要结论给出可核查的位置或链接；区分「已读到」「已核实」「无法确认」。
- 交付默认是带引用的简明结论（短名单、关键事实、局限），不是大段原文摘抄。
- 只有任务要求，或项目已有笔记约定时，才落一份 Markdown 文件，并说明位置。
- 不虚构未读内容；资料不足时明确写出缺口。

## 来源与许可

改编自 Matt Pocock 的 [skills](https://github.com/mattpocock/skills) 仓库（commit `5beb35b040e3de97e54fa9e386d7e42d15c295c2`），MIT License；本仓库版本为 DSH 适配版，与原文存在差异。完整许可见仓库根目录 `NOTICE`。

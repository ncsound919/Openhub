---
name: grilling
description: 当用户想压力测试一个计划、决策或想法，或说“拷问我 / grill me”时使用。通过逐轮提问把目标、边界和验收问清楚，先确认再动手。
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Word each question so "yes" accepts your recommended answer.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.

## 在 DSH 团队中的用法

本节为 DSH 适配说明；与上文英文原文冲突时，以本节为准。

- 先查事实，再问决定：能从工作区、文档、工具或获准的委派中查到的，不要拿去问用户。
- 每轮只问前置条件已满足的问题，逐条编号，并给出你推荐的答案。
- 只问会改变方向、范围或验收的问题；用户已答过或已有既定决定的不要重复追问。
- 需要委派时先取得团队规则或用户授权，不自行召唤成员。
- 决策树走完，或证据已足以形成建议时收敛；不必把每个细枝末节都问到底。
- 结论显式列出：已确认的目标、范围、验收方式、仍待定事项。
- 本技能默认只讨论；用户明确要求后才进入实施。

## 来源与许可

改编自 Matt Pocock 的 [skills](https://github.com/mattpocock/skills) 仓库（commit `5beb35b040e3de97e54fa9e386d7e42d15c295c2`），MIT License；本仓库版本为 DSH 适配版，与原文存在差异。完整许可见仓库根目录 `NOTICE`。

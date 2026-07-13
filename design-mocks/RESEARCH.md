# SOP 首屏视觉方向调研

调研目标：在不改变页面结构、业务逻辑和交互路径的前提下，为当前“左侧导航 + 顶栏 + 搜索工具栏 + 数据表格”首屏寻找简洁、现代、低改动的视觉语言。

## 本项目的落地边界

- 保留现有 240px 侧栏、六个导航项、页面标题、刷新、搜索、结果数、新建按钮和九列表格。
- 优先通过 `App.css` 的颜色、字体层级、边框、圆角、阴影和间距完成；不引入 UI 框架。
- 品牌强调色只保留一个；红、黄、绿只承担状态语义。
- 保留 960px 响应式断点、表格横向滚动、focus ring、hover/disabled/notice 状态。
- 所有数字列使用 tabular numbers，间距尽量收敛到 4/8px 节奏。

## 6 个候选方向

| 方案 | 视觉特征 | 相对改动 | 适合点 |
| --- | --- | --- | --- |
| 01 Primer Precision | 冷白、浅灰、细边框、单一蓝、6px 圆角 | 最小 | 与当前结构最接近，最稳妥 |
| 02 Carbon Compact | 冷灰分层、方正控件、紧凑表格、单一蓝 | 低 | 数据密度和专业工具感最强 |
| 03 Linear Soft | 发丝边框、柔和紫蓝、极轻浮层、8–10px 圆角 | 中低 | 更年轻、更精致 |
| 04 Warm Editorial | 暖白暖灰、低对比边框、更多留白 | 低 | 温和、阅读友好 |
| 05 Atlassian Structured | 8px 节奏、清晰容器、强层级蓝 | 低 | 复杂工作流易扫描 |
| 06 Vercel Monochrome | 黑白灰、无阴影、强排版、细网格 | 中 | 最简、最现代 |

Linear、Warm Editorial、Vercel 使用了社区提取的 inspired 资料，不表示官方设计规范；其余方向主要依据官方设计系统原则。Warm Editorial 同时吸收了编辑台账依靠排版、线条和节奏建立层级的做法。

## 主要资料

- [Google Labs DESIGN.md](https://github.com/google-labs-code/design.md)：用 tokens + rationale 描述颜色、字体、圆角、间距与组件规则。
- [VoltAgent Awesome DESIGN.md](https://github.com/VoltAgent/awesome-design-md)：公开 DESIGN.md 与 preview 合集，本次用于 Linear、Notion、Vercel 的社区视觉分析。
- [bergside Awesome Design Skills](https://github.com/bergside/awesome-design-skills)：DESIGN.md / SKILL.md 风格技能合集。
- [alexpate Awesome Design Systems](https://github.com/alexpate/awesome-design-systems) 与 [klaufel Awesome Design Systems](https://github.com/klaufel/awesome-design-systems)：成熟设计系统、tokens、pattern library、可访问性资料索引。
- [GitHub Primer](https://primer.github.io/design/) 与 [Primer GitHub organization](https://github.com/primer)：GitHub 产品界面的 foundations、patterns 和 primitives。
- [IBM Carbon](https://github.com/carbon-design-system/carbon) 与 [Carbon Data Table 样式](https://carbondesignsystem.com/components/data-table/style/)：高密度企业数据表的分层与状态规则。
- [Microsoft Fluent 2 设计原则](https://fluent2.microsoft.design/design-principles) 与 [颜色规则](https://fluent2.microsoft.design/color)：以 neutral surfaces 为主体、品牌色克制使用。
- [Atlassian Foundations](https://atlassian.design/foundations) 与 [Grid / spacing](https://atlassian.design/foundations/grid-beta/applying-grid)：8px 基准与层级化布局。
- [GitLab Pajamas 原则](https://design.gitlab.com/get-started/principles)：sophisticated simplicity、避免 gimmick、保持工作流自然可预测。
- [Ant Design values](https://ant.design/docs/spec/values/)：企业产品中的克制、确定性、一致性和模块化。
- [Figma Simple Design System](https://github.com/figma/sds)：设计变量、组件和 React 实现之间的对应实践。
- [Adobe Spectrum Design Data](https://github.com/adobe/spectrum-design-data)、[Tencent TDesign](https://github.com/Tencent/tdesign)、[USWDS](https://github.com/uswds/uswds)：可访问性、跨栈 token 与企业组件参考。

## 初步建议

如果优先考虑最小落地成本，先重点比较 `01 Primer`、`02 Carbon`、`05 Atlassian`；如果希望明显提升现代感，再比较 `03 Linear` 和 `06 Vercel`。最终选定后，建议先在 `App.css` 顶部引入一组 CSS variables，再机械替换现有硬编码颜色和圆角，保持 `App.tsx` 业务结构不动。

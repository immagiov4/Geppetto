# Third-party notices

## Canonical source snapshot

The six bundled skills were copied from [immagiov4/my-codex-skills](https://github.com/immagiov4/my-codex-skills/tree/fe258e71ea9ba3de0a67e7ef9d5e40e0c27cce54/skills), commit `fe258e71ea9ba3de0a67e7ef9d5e40e0c27cce54`, from a clean checkout. Local HEAD and remote main matched that commit on October 25, 2026. Their scripts, references, schemas and invocation metadata travel with them.

| Bundled path | Origin and licensing evidence in that snapshot | Local adaptation |
| --- | --- | --- |
| `skills/writing-for-agents` | Matt Pocock's writing-for-agents, adapted in my-codex-skills. `licenses/MATTPOCOCK-MIT.txt` supplies the MIT notice, copied into the skill as `LICENSE.txt`. | Retain canonical guidance/mechanics and metadata; add shared execution/integration pointer. |
| `skills/requirements-blast-radius` | immagiov4; source repository `LICENSE` (MIT). | Preserve source, helpers, references and tests; add Geppetto consent/process integration so optional paid screening cannot bypass authorization. |
| `skills/skill-learning-patterns` | immagiov4 adaptation of e-bash, with methods studied in Hermes. Source `LICENSE` and skill `LICENSE.txt` (MIT, Oleksandr Kucherenko). | Point its license reference to its bundled notice; add execution/integration pointers. |
| `skills/code-review` | immagiov4; source repository `LICENSE` (MIT). Procedure studies Qwen Code at `b906f937ec041ca9124617bf86726de064bea967`. | Translate instructions, UI metadata, provenance reference, helper prompts/messages/comments to English; add hidden Windows child launches, consent/process guidance and a constrained-session self-review handoff. Select an available verification runtime while retaining the Codex runner, independent searches, confirmation and schemas. |
| `skills/receive-work-feedback` | immagiov4; source repository `LICENSE` (MIT). | Rename the source receiving-pr-reviews skill to receive-work-feedback, translate its display metadata, remove the engineering-workflow handoff, and add optional companion resolution and process guidance. All finding/authority/scope rules remain. |
| `skills/retro` | immagiov4; source repository `LICENSE` (MIT). | Faithfully translate skill and UI text; clarify optional companion discovery and shared process guidance. Preserve explicit invocation policy. |

The older design proposal recorded uncertainty about Matt Pocock's license. The canonical source snapshot now contains the notice reproduced here; this records supplied provenance, rather than an independent audit of upstream history. Original work and local adaptations in the source repository are MIT; upstream material retains its original notices.

## Earlier derivations retained by the bundles

`writing-for-agents` derives from [mattpocock/skills](https://github.com/mattpocock/skills/tree/main/skills/productivity/writing-for-agents). Its exact upstream revision is not recorded in the canonical skill; the reproducible source for this bundle is the my-codex-skills commit above.

`skill-learning-patterns` records [e-bash skill-learning](https://github.com/OleksandrKucherenko/e-bash/blob/26d905b30c65d57c6707049c8ace9aba2d20fe61/.claude/skills/skill-learning/SKILL.md), commit `26d905b30c65d57c6707049c8ace9aba2d20fe61`, and Hermes sources at `f594424e58f18ebc2607decaa72f300e0a26a24b`. See its [source/adaptation reference](skills/skill-learning-patterns/references/sources.md). The bundled e-bash notice remains intact.

`code-review` records Qwen methodology and differences in [its provenance reference](skills/code-review/references/qwen-method.md); that reference is explanatory attribution, not a claim of equivalent coverage. Canonical runtime helpers retain their original languages (Python and optional Bun) as a documented exception to the new dependency-free Node machinery.

## MIT notices

The following copyright notices apply to their respective material above:

```text
Copyright (c) 2026 immagiov4
Copyright (c) 2026 Matt Pocock
Copyright (c) 2017-current Oleksandr Kucherenko

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Exact individual upstream/source notices are also preserved as `LICENSE.txt` inside each bundled skill. This document covers bundled material; it does not assign a new license to unrelated Geppetto contributions.

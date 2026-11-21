---
"@lazysh/client": patch
---

fix(agents): choosing another agent in the Agent view now focuses its terminal pane and shows its composer

Switching agent from the Agent view's live list moves the Herdr focus to that agent's pane, so the terminal follows and the composer for the newly shown agent appears instead of "Not this pane". Picking an agent or session in the left menu while the Agent view is shown keeps the Agent view open.

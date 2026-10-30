---
name: push
description: Publica o CodePet neste PC (bump patch, testes, commit de release, executável portátil e substituição da instalação local). Use when the user explicitly invokes /push or this skill inside the CodePet repository.
argument-hint: "-PlanOnly | -SelfTest | -ResumeFrom Build|Install|Push -ReleaseCommit <sha>"
allowed-tools:
  - Bash
---

# Push do CodePet

Fonte canônica: `.agents/skills/push/SKILL.md`, a mesma da skill do Codex. Abra esse arquivo e siga integralmente; o script `.agents/skills/push/scripts/codepet_push.ps1` é único para os agentes.

No Claude Code, rode o script com `run_in_background` e acompanhe a saída, porque o fluxo completo passa do tempo limite de um comando em primeiro plano. Encaminhe `$ARGUMENTS` como flags do script.

Sem `/push` explícito, não rode build publicável, commit nem `git push`.

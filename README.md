# Celeste HQ

Une app de bureau qui montre, en 3D pixel art, un open space où travaillent tous les agents Claude Code lancés sur ce PC : chaque projet a ses bureaux, chaque agent a sa fiche (outils, tâche en cours, derniers changements, conversations), et le CEO (l'opérateur humain) valide les demandes.

## État

Étape 1 : maquette interactive avec des données d'exemple → [`mockups/openspace.html`](mockups/openspace.html) (à ouvrir dans un navigateur).

## Architecture visée (tout en local, pas de Vercel)

```
Claude Code (CLI / app desktop)
  ├─ hooks : SessionStart, PreToolUse, PostToolUse, SubagentStart/Stop, Notification, Stop
  │    └─ petit script → POST http://localhost:4747/events
  └─ transcripts ~/.claude/projects/**/*.jsonl  (relus en continu pour l'historique)
            │
            ▼
  Serveur local Node (« bridge ») : normalise les événements en état d'agents
            │ WebSocket
            ▼
  Front three.js (rendu basse résolution → pixel art), empaqueté en app avec Tauri ou Electron
```

| Ce qu'on voit dans l'open space | D'où vient l'info |
| --- | --- |
| Un agent qui arrive / repart | SessionStart, SubagentStart / SubagentStop, Stop |
| Il tape au clavier, bulle « Edit fichier.ts » | PreToolUse / PostToolUse (nom de l'outil + paramètres) |
| Derniers changements (+/−) | PostToolUse des outils Edit / Write |
| Outils accessibles | frontmatter `tools:` des agents (`.claude/agents/*.md`) + serveurs MCP configurés |
| « Discute avec » | appel de l'outil Agent (parent → sous-agent) et son résultat |
| Point d'exclamation, demande au CEO | Notification (demande de permission) |

# Celeste HQ

Une app de bureau qui montre, en 3D pixel art, tous les projets Claude Code de ce PC comme une entreprise : un bâtiment sur un seul étage où chaque projet a sa pièce (ou plusieurs), avec son manager (la session principale) et ses sous-agents. Quand un projet démarre ou reprend, sa pièce s'ajoute au bâtiment ou se rallume. Chaque agent a sa fiche (outils, tâche en cours, derniers changements, conversations), et le CEO (l'opérateur humain) valide les demandes.

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
| Pièce d'un projet qui s'ajoute / se rallume | première session vue dans un nouveau dossier / session reprise dans un dossier connu |
| Le CEO se lève et va porter une tâche à un manager | tu envoies un message dans une session Claude Code (UserPromptSubmit) |
| Un manager va porter une tâche à un agent | appel de l'outil Agent (création d'un sous-agent avec sa consigne) |
| Un agent rend son rapport puis quitte le bâtiment | SubagentStop : le sous-agent a fini, son bureau disparaît |
| Toilettes, cantine, café, réunion d'équipe | animations d'ambiance quand un agent attend (commande longue, inactivité) ; les discussions y sont inventées |
| Panneau « À retenir » | le bridge envoie les événements importants par lots à Claude Haiku (API) qui écrit un résumé de 2 à 4 lignes ; le journal brut reste consultable |

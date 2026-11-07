# Celeste HQ

Tes projets Claude Code vus comme une entreprise, en 3D pixel art, en direct sur ton PC.

- Chaque **projet** (dépôt git) est une pièce du bâtiment, avec sa couleur. Une pièce s'ajoute quand un nouveau projet démarre, se rallume quand il reprend, s'assombrit quand il est en pause. Un projet très actif peut occuper plusieurs pièces.
- Chaque **session Claude Code** est un manager (casque sur la tête), assis au grand bureau de la pièce.
- Chaque **sous-agent** (outil Agent : Explore, Plan, tes agents perso…) arrive par la porte d'entrée, s'installe à un bureau qui apparaît, reçoit sa consigne du manager, travaille, puis rapporte et repart.
- **Toi**, tu es le CEO : quand tu envoies un message à une session, ton personnage se lève et va lui porter la consigne.
- Clique sur un agent pour sa fiche : tâche en cours, outils utilisés ou autorisés, derniers fichiers modifiés (+/−), échanges.
- Le panneau **« À retenir »** résume ce qui compte (validations en attente, sessions qui attendent ta réponse, tests en échec, tâches terminées). Il est écrit par Claude Haiku si une clé API est configurée, sinon par un résumé local.

Les agents qui attendent ta réponse vont prendre un café, déjeuner à la cantine ou se réunir : c'est de l'ambiance, les discussions y sont inventées. Tout le reste vient de tes vraies sessions.

## Installation

Prérequis : [Node.js](https://nodejs.org) 20 ou plus récent, et Claude Code (CLI ou application de bureau).

```bash
npm install
```

```bash
npm run hooks:install
```

La deuxième commande ajoute des hooks HTTP dans `~/.claude/settings.json` (une sauvegarde du fichier est faite avant). Redémarre ensuite tes sessions Claude Code pour qu'elles les prennent en compte.

Pour le résumé par Haiku, copie `.env.example` en `.env` et mets ta clé dans `ANTHROPIC_API_KEY`. Le fichier `.env` est ignoré par git.

## Utilisation

```bash
npm start
```

L'app s'ouvre dans ton navigateur sur http://127.0.0.1:4747/. Garde ce terminal ouvert ; tes sessions Claude Code apparaissent dès qu'elles font quelque chose. Les projets sur lesquels tu as déjà travaillé (lus dans `~/.claude/projects`) sont affichés comme pièces en pause.

Pour voir l'app vivre sans lancer Claude Code :

```bash
npm run demo
```

### Répondre aux demandes de permission depuis l'app

Par défaut, une demande de permission s'affiche dans l'app (point d'exclamation, panneau « À retenir », fiche du CEO) mais tu y réponds dans Claude Code. Pour pouvoir cliquer « Valider » ou « Refuser » dans l'app :

```bash
npm run hooks:install-approvals
```

Claude Code attend alors jusqu'à 50 secondes ta réponse dans l'app, puis affiche sa fenêtre de permission habituelle si tu n'as pas répondu.

### Lancer une session depuis l'app

Dans la fiche d'un projet ou d'un manager, « Lancer une session » démarre `claude -p "ta consigne"` dans le dossier du projet. C'est une **nouvelle** session non interactive : elle n'a que les permissions déjà accordées dans tes réglages Claude Code. Son journal est écrit dans `~/.celeste-hq/logs/`.

### Désinstaller les hooks

```bash
npm run hooks:uninstall
```

Seules les entrées de Celeste HQ sont retirées ; tes autres hooks ne sont pas touchés. Quand l'app n'est pas lancée, les hooks échouent sans bloquer Claude Code ; désinstalle-les si tu n'utilises plus l'app.

## Comment ça marche

```
Claude Code ──hooks HTTP──▶ serveur local (server/) ──Server-Sent Events──▶ app 3D (web/index.html, three.js)
                                 │
                                 └─ toutes les 30 s, si du nouveau : Claude Haiku écrit « À retenir »
```

| Dans l'app | Événement Claude Code |
| --- | --- |
| Une pièce apparaît / se rallume | `SessionStart` ou premier événement d'une session dans un projet |
| Le CEO va porter une consigne au manager | `UserPromptSubmit` |
| Un agent tape au clavier, bulle d'outil (agent sélectionné) | `PreToolUse` |
| Derniers changements (+/−) | `PostToolUse` sur Edit / Write / MultiEdit / NotebookEdit |
| Un sous-agent arrive, le manager lui porte sa consigne | `PreToolUse` de l'outil Agent puis `SubagentStart` |
| Le sous-agent rapporte au manager puis s'en va | `SubagentStop` |
| Point d'exclamation, demande au CEO | `Notification` (permission) ou `PermissionRequest` (option approvals) |
| Le manager attend ta réponse (et va en pause) | `Stop` |
| Le manager quitte le bâtiment, la pièce s'éteint | `SessionEnd` |
| Outils autorisés d'un sous-agent | frontmatter `tools:` de `.claude/agents/*.md` et `~/.claude/agents/*.md`, ou agents intégrés (Explore, Plan) |

## Sécurité

- Le serveur n'écoute que sur `127.0.0.1`.
- L'app utilise un jeton aléatoire, renouvelé à chaque lancement, pour lire l'état, répondre aux demandes et lancer des sessions.
- `/hook` refuse les requêtes venant d'un navigateur (en-tête `Origin`), pour qu'un site web ne puisse pas y injecter de faux événements.
- La consigne d'une session lancée depuis l'app est passée à `claude` par l'entrée standard, jamais par la ligne de commande.
- Les données envoyées à Haiku (noms de projets, consignes, noms de fichiers, demandes) partent vers l'API Anthropic. Sans clé, rien ne sort de ton PC.

## Réglages (`.env`)

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | vide | active le résumé par Haiku |
| `SUMMARY_MODEL` | `claude-haiku-5-5` | modèle du résumé |
| `CELESTE_PORT` | `4747` | port local (relance `npm run hooks:install` si tu le changes) |
| `CELESTE_DATA_DIR` | `~/.celeste-hq` | liste des projets connus, journaux des sessions lancées |

## Développement

```bash
npm test
```

- `server/state.js` : transforme les hooks en projets / managers / sous-agents (testé dans `test/`).
- `server/summary.js` : résumé « À retenir » (Haiku avec sortie structurée, ou local).
- `server/demo.js` : sessions fictives au format exact des hooks.
- `web/index.html` : l'app 3D.
- `mockups/openspace.html` : la maquette d'origine, entièrement simulée.

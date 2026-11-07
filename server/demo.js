// Demo mode: plays fake Claude Code sessions by feeding hook payloads (same shape as the real ones)
// into the store, so the whole pipeline can be seen without running Claude Code.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];
const lines = n => Array.from({length:n}, (_, i) => `ligne ${i}`).join('\n');

const PROJECTS = {
  celeste:{cwd:'/demo/celeste', files:['src/auth/session.ts', 'src/auth/oauth.ts', 'src/api/client.ts', 'README.md'],
    prompts:['Implémente la connexion OAuth et branche la session sur l’API.', 'Ajoute un mode sombre à l’interface.', 'Corrige le bug de déconnexion signalé ce matin.'],
    subs:[['Explore', 'Cartographie les appels API du front'], ['Plan', 'Plan de migration vers SQLite'], ['code-reviewer', 'Relire la PR auth'], ['test-runner', 'Écrire les tests du login']]},
  vitrine:{cwd:'/demo/site-vitrine', files:['src/components/Hero.tsx', 'src/styles/hero.css', 'tests/contact.spec.ts'],
    prompts:['Refais le hero de la page d’accueil.', 'Ajoute des tests Playwright au formulaire de contact.'],
    subs:[['frontend-dev', 'Animer le hero'], ['test-runner', 'Tests du formulaire de contact']]},
  factures:{cwd:'/demo/api-factures', files:['api/invoices.ts', 'api/db.ts', 'api/schema.sql'],
    prompts:['Crée le squelette d’une API de factures en Node + SQLite.', 'Ajoute la pagination à /invoices.'],
    subs:[['Explore', 'Repérer les formats de facture'], ['general-purpose', 'Écrire les migrations SQL']]},
  discord:{cwd:'/demo/bot-discord', files:['src/commands/meteo.ts', 'src/index.ts'],
    prompts:['Reprends la commande /meteo là où on s’était arrêté.'],
    subs:[['Explore', 'Lire la doc de l’API météo']]},
};

let counter = 0;
async function tools(hook, base, cwd, files, n, agent){
  for (let i = 0; i < n; i++){
    const extra = agent ? {agent_id:agent.id, agent_type:agent.type} : {};
    const kind = pick(agent && agent.ro ? ['Read', 'Grep', 'Glob'] : ['Read', 'Grep', 'Edit', 'Edit', 'Write', 'Bash']);
    const file = `${cwd}/${pick(files)}`;
    const input = kind === 'Bash' ? {command:pick(['npm test', 'npm run build', 'git status'])}
      : kind === 'Grep' ? {pattern:pick(['fetchUser', 'TODO', 'session'])} : kind === 'Glob' ? {pattern:'src/**/*.ts'}
      : kind === 'Edit' ? {file_path:file, old_string:lines(Math.ceil(rnd(1, 6))), new_string:lines(Math.ceil(rnd(2, 20)))}
      : kind === 'Write' ? {file_path:file, content:lines(Math.ceil(rnd(10, 60)))} : {file_path:file};
    const id = 'toolu_demo' + (++counter);
    hook({...base, ...extra, hook_event_name:'PreToolUse', tool_name:kind, tool_input:input, tool_use_id:id});
    await sleep(rnd(900, 2600));
    const fail = kind === 'Bash' && input.command === 'npm test' && Math.random() < .25;
    hook({...base, ...extra, hook_event_name:fail ? 'PostToolUseFailure' : 'PostToolUse', tool_name:kind, tool_input:input, tool_response:kind === 'Write' ? {type:'update'} : {}, tool_use_id:id});
    await sleep(rnd(500, 1800));
  }
}

async function session(store, key, {startDelay = 0, rounds = Infinity, approval = false} = {}){
  const P = PROJECTS[key];
  await sleep(startDelay);
  const sid = `demo-${key}-${Date.now()}`;
  const base = {session_id:sid, cwd:P.cwd, transcript_path:'', permission_mode:'default'};
  const hook = b => store.handleHook(b);
  hook({...base, hook_event_name:'SessionStart', source:'startup', model:pick(['claude-opus-5-5', 'claude-sonnet-5-5'])});
  await sleep(4000);
  for (let r = 0; r < rounds; r++){
    hook({...base, hook_event_name:'UserPromptSubmit', prompt:P.prompts[r % P.prompts.length]});
    await sleep(6000);
    await tools(hook, base, P.cwd, P.files, 2);
    // delegate to 1–2 sub-agents working in parallel
    const subs = [...P.subs].sort(() => Math.random() - .5).slice(0, Math.min(P.subs.length, 1 + Math.floor(Math.random() * 2)));
    await Promise.all(subs.map(async ([type, desc], i) => {
      await sleep(i * 2500);
      const agentId = `agent-${key}-${++counter}`;
      const ro = type === 'Explore' || type === 'Plan' || type === 'code-reviewer';
      hook({...base, hook_event_name:'PreToolUse', tool_name:'Agent', tool_input:{subagent_type:type, description:desc, prompt:desc + '. Rends un rapport court.'}, tool_use_id:'toolu_a' + counter});
      await sleep(500);
      hook({...base, hook_event_name:'SubagentStart', agent_id:agentId, agent_type:type});
      await sleep(9000);
      await tools(hook, base, P.cwd, P.files, Math.ceil(rnd(3, 7)), {id:agentId, type, ro});
      hook({...base, hook_event_name:'SubagentStop', agent_id:agentId, agent_type:type, last_assistant_message:`${desc} : terminé. ${pick(['3 points à corriger.', 'Tout est en ordre.', 'Voir les fichiers modifiés.'])}`});
    }));
    await tools(hook, base, P.cwd, P.files, 2);
    if (approval && r % 2 === 0){
      hook({...base, hook_event_name:'Notification', notification_type:'permission_prompt', message:'Claude a besoin de ta permission pour utiliser Bash : git push origin main'});
      await sleep(25000);
    }
    hook({...base, hook_event_name:'Stop', last_assistant_message:`C’est fait : ${P.prompts[r % P.prompts.length].toLowerCase()}`});
    await sleep(rnd(25000, 45000));
  }
  hook({...base, hook_event_name:'SessionEnd', reason:'other'});
}

export function startDemo(store){
  const now = Date.now();
  store.seedProjects([{cwd:'/demo/bot-discord', lastActive:now - 3 * 86400e3}, {cwd:'/demo/scripts-perso', lastActive:now - 14 * 86400e3}]);
  session(store, 'celeste', {approval:true});
  session(store, 'vitrine', {startDelay:3000});
  session(store, 'factures', {startDelay:45000, rounds:3});
  session(store, 'discord', {startDelay:90000, rounds:2});
}

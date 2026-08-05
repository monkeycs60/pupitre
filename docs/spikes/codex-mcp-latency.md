# Spike — latence MCP de Codex app-server

Date : 5 août 2026  
Codex CLI : `0.144.5`  
Modèle : Luna (`gpt-5.6-luna`), effort low, tier fast  
Prompt : `Réponds uniquement : OK.`

## Résultats

Les probes utilisent directement le protocole JSON-RPC de
`codex app-server`, avec la configuration Codex réelle de la machine.

| Profil | Premier contenu | Tour terminé | Observation |
|---|---:|---:|---|
| Configuration complète | 122 745 ms | 122 821 ms | le MCP Sentry expire après 120 s |
| Sentry seul désactivé | 6 783 ms | 6 876 ms | tous les autres MCP et plugins restent actifs |
| Tous actifs, timeout Sentry à 5 s | 8 562 ms | 9 018 ms | Sentry échoue vite, sans perte de capacité configurée |
| Adaptateur Pupitre sans conductor, tous les MCP bornés à 5 s | 8 485 ms | 8 567 ms | le chemin non orchestré était déjà corrigé |
| Thread orchestrateur, borne au process seulement | 123 429 ms | 123 506 ms | l'override `mcp_servers.conductor` restaure le timeout de 120 s |
| Thread orchestrateur, borne répétée dans le thread | 11 461 ms | 11 569 ms | chemin applicatif orchestré corrigé |

Tous les autres MCP observés étaient prêts en moins de 4,35 s. Canva échouait
rapidement sur son authentification OAuth et ne bloquait pas le tour. Le mode
fast et le bridge `conductor` n'étaient donc pas responsables des deux minutes
d'attente : le blocage provenait du handshake du transport MCP Sentry.

## Décision

Pupitre lance désormais Codex avec la politique `bounded` par défaut :

- plugins conservés ;
- MCP utilisateur conservés ;
- `startup_timeout_sec=5` injecté pour chaque MCP classique trouvé dans
  `~/.codex/config.toml` ;
- bridge `conductor` toujours ajouté par thread ;
- politique MCP répétée dans la configuration du thread orchestrateur.

Ce dernier point est nécessaire car l'override `mcp_servers` qui ajoute
`conductor` passe après les arguments de configuration du process Codex. Sans
lui, le thread réutilise notamment les 120 secondes configurées pour Sentry,
même si le process a reçu une borne de 5 secondes.

Cette borne générique évite qu'un autre MCP indisponible reproduise la même
latence. Un MCP qui dépasse la borne échoue pour ce démarrage, mais n'est ni
supprimé ni désactivé dans la configuration utilisateur.

Deux politiques explicites restent disponibles :

- `PUPITRE_CODEX_MCP_POLICY=full` : aucune surcharge ;
- `PUPITRE_CODEX_MCP_POLICY=off` : plugins et MCP utilisateur désactivés pour
  diagnostiquer une panne.

La borne se règle avec `PUPITRE_CODEX_MCP_STARTUP_TIMEOUT_SEC`. L'ancien
`PUPITRE_CODEX_USER_MCPS=1` reste accepté comme alias de `full` lorsque la
nouvelle politique n'est pas définie.

## Reproduire

Depuis `sidecar/` :

```bash
# Configuration complète
bun scripts/probe-codex-latency.ts

# Isoler Sentry
bun scripts/probe-codex-latency.ts -- -c mcp_servers.sentry.enabled=false

# Conserver Sentry mais borner son handshake
bun scripts/probe-codex-latency.ts -- -c mcp_servers.sentry.startup_timeout_sec=5
```

Le script affiche les jalons du tour et l'état de démarrage de chaque MCP en
JSON. Il consomme un vrai tour Codex ; il n'est donc pas inclus dans les tests
automatisés.

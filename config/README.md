# Réglages des projets personnels

`personal-projects.json` reprend les commandes déclarées dans les manifestes et les README des projets locaux au 2 octobre 2026. Le sidecar les installe une fois par projet au démarrage, uniquement si le nom du projet et celui du dossier correspondent. Une commande ou un environnement du même nom reste intact ; les modifications et suppressions ultérieures ne sont pas annulées au redémarrage.

Aucune commande n’est exécutée pendant l’installation. Les commandes de vérification sont manuelles. Aucun jeton, mot de passe ou fichier `.env` n’est copié dans ces réglages.

| Projet | Commandes | Environnement personnel |
|---|---|---|
| Helion | Développement Rust/Wasm/Vite ; tests Rust et TypeScript | HTTPS public documenté |
| veille-immo | Serveur local avec ordonnanceur et Telegram coupés ; tests/types | Production privée non configurée : alias SSH et accès Coolify à préciser |
| Vrac (`todo-app`) | API locale ; Expo web utilisant cette API ; vérifications serveur et interface | `/health` du backend HTTPS |
| politics-cards | API et application ; tests/types/lint | Aucun hébergement établi |
| coworker-malin | Développement avec PostgreSQL local ; Vitest | Aucun nouvel environnement déduit |
| coworking | Site Next sur 3002 ; Vitest | Aucun nouvel environnement déduit |
| recall-people-2026 | API avec PostgreSQL local ; Expo ; vérification API | Adresse de production non établie ici |
| vinted-arbitrage | Tests extension et worker | Aucun serveur lancé automatiquement |

Les scripts Doppler conservent leur authentification habituelle. Vrac nécessite son fichier serveur `.env` existant. Les projets partageant un port ne doivent pas être lancés simultanément sans adapter leurs configurations ; le bouton de lancement signale le port principal occupé. Helion et politics-cards utilisent plusieurs ports : le port déclaré pour le suivi ne doit pas être injecté comme `PORT` dans tous leurs processus. Seul le choix explicite d’un port alternatif surcharge cette variable, et un serveur qui ignore `PORT` doit être configuré via sa commande.

Aucun déploiement des projets n’est déclenché. Pupitre, Affilae, Downloads et les dossiers sans commande d’application établie sont exclus de ce préréglage.

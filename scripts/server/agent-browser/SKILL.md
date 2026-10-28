---
name: agent-browser
description: Pilote Chrome sur le VPS Pupitre pour ouvrir une page, tester une interface, capturer ou filmer un parcours. À utiliser pour @browser.
---

# Navigateur du VPS

`ab` ouvre un Chrome headless sur le VPS, dans une session propre à la conversation. Il fonctionne même quand le PC de Clément est éteint. Ce navigateur démarre sans les comptes ni les cookies du PC.

```bash
ab open https://example.com
ab snapshot -i
ab click @e3
ab get title
ab screenshot /tmp/capture.png
ab close
```

Les références `@eN` changent après une navigation : relire le snapshot. Utiliser le snapshot texte avant une capture, sauf pour juger la présentation.

Pour un parcours d'interface, filmer avant et après avec le même viewport :

```bash
ab set viewport 390 844
ab record start /tmp/parcours.webm https://example.com --fps 15 --cursor
ab click @e3
ab record stop
ffmpeg -loglevel error -y -i /tmp/parcours.webm -c:v libx264 -pix_fmt yuv420p -crf 28 -preset veryfast -movflags +faststart -an /tmp/parcours.mp4
```

Publier les livrables via l'outil Pupitre `publish_document`, avec captures et vidéos intégrées en data URI dans un HTML. Fermer seulement la session de la conversation avec `ab close`.

Les actions se font au nom de Clément ; son autorisation explicite est nécessaire pour un envoi, une publication, un achat ou une suppression hors du périmètre déjà autorisé.

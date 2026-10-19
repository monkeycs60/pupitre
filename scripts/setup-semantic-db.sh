#!/bin/bash
# Base pgvector de la recherche IA des conversations : un conteneur Docker local
# partagé par les deux instances (bases `pupitre` et `pupitre_dev`, créées par le sidecar).
set -euo pipefail

CONTAINER="${PUPITRE_SEMANTIC_CONTAINER:-pupitre-pg}"
PORT="${PUPITRE_SEMANTIC_PORT:-5435}"

command -v docker >/dev/null 2>&1 || { echo "Docker est requis pour la recherche IA." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker ne répond pas : lance-le puis relance cette commande." >&2; exit 1; }

if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "Conteneur $CONTAINER déjà lancé."
elif docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  docker start "$CONTAINER" >/dev/null
  echo "Conteneur $CONTAINER redémarré."
else
  docker run -d --name "$CONTAINER" --restart unless-stopped \
    -e POSTGRES_PASSWORD=pupitre -e POSTGRES_DB=pupitre \
    -p "127.0.0.1:$PORT:5432" pgvector/pgvector:pg16 >/dev/null
  echo "Conteneur $CONTAINER créé sur 127.0.0.1:$PORT."
fi

for _ in $(seq 1 30); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && { echo "pgvector prêt."; exit 0; }
  sleep 1
done
echo "pgvector ne répond pas après 30 s." >&2
exit 1

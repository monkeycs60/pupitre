#!/bin/bash
cd "$(dirname "$0")" || exit 1
bash scripts/setup.sh "$@"
status=$?
if [ "$status" -ne 0 ]; then
  printf '\nInstallation interrompue. Consultez le message ci-dessus. Appuyez sur Entrée pour fermer.'
  read -r _
fi
exit "$status"

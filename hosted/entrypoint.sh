#!/bin/sh
# Starts the bb server of a hosted machine. Only /data survives a stop, so the
# server's data and the home directory of the user it runs as both live there.
set -eu

if [ ! -d /data/home ]; then
  mkdir -p /data/home
  cp -rT /etc/skel /data/home
  chown -R bb:bb /data/home
fi
mkdir -p /data/bb
chown bb:bb /data /data/bb

cd /opt/bb
exec setpriv --reuid=bb --regid=bb --init-groups \
  node --conditions=source --import tsx apps/server/src/main.ts

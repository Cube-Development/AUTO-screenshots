#!/bin/bash
set -e

TAG=$(date +%Y%m%d%H%M%S)
IMAGE=abddssh/screenshots

echo "Building image $IMAGE:$TAG"

docker build -f Dockerfile -t $IMAGE:$TAG -t $IMAGE:latest .
docker push $IMAGE:$TAG
docker push $IMAGE:latest

echo "Pushed $IMAGE:$TAG and latest"
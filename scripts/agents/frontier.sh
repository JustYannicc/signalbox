#!/usr/bin/env bash
# Prints the dogfood map's frontier: open `dogfood` or `easy-win` issues, one per
# line, with their routing labels and the issues still blocking them. An issue
# with an empty `blocked:` column is ready to hand to an agent.
#
# Usage: scripts/agents/frontier.sh [owner/repo]
set -euo pipefail

repo="${1:-JustYannicc/signalbox}"

gh api graphql --paginate \
  -f owner="${repo%%/*}" -f name="${repo#*/}" \
  -f query='query($owner:String!,$name:String!,$endCursor:String){repository(owner:$owner,name:$name){issues(first:100,after:$endCursor,states:OPEN,labels:["dogfood","easy-win"]){pageInfo{hasNextPage endCursor} nodes{number title labels(first:20){nodes{name}} blockedBy(first:20){nodes{number state}}}}}}' \
  --jq '.data.repository.issues.nodes[] | {n:.number, t:.title, l:[.labels.nodes[].name], b:[.blockedBy.nodes[]|select(.state=="OPEN")|.number]} | "\(.n)\t\((.l|map(select(.=="dogfood" or .=="easy-win" or .=="ready-for-agent" or startswith("area") or .=="frontend" or .=="needs-design"))|join(",")))\tblocked:\(.b|join(","))\t\(.t)"'

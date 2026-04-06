#!/bin/bash
# Auto-update SSH security group IP
# Usage: bash scripts/update-ip.sh

SECURITY_GROUP_ID="sg-0b452f232f34ddede"
REGION="us-east-1"
SSH_KEY="~/.ssh/prod_key_factiii.pem"
SSH_USER="ubuntu"
SSH_HOST="54.145.160.123"

# Fetch all SSH (port 22) rules from the security group
echo "Fetching SSH rules from security group..."
RULES_JSON=$(aws ec2 describe-security-group-rules \
  --filter "Name=group-id,Values=$SECURITY_GROUP_ID" \
  --query "SecurityGroupRules[?FromPort==\`22\` && ToPort==\`22\` && !IsEgress].[SecurityGroupRuleId,CidrIpv4,Description]" \
  --output json --region "$REGION" 2>/dev/null)

if [ -z "$RULES_JSON" ] || [ "$RULES_JSON" = "[]" ]; then
  echo "ERROR: No SSH rules found in security group $SECURITY_GROUP_ID"
  exit 1
fi

# Parse rules into arrays
RULE_COUNT=$(echo "$RULES_JSON" | jq length)
if [ "$RULE_COUNT" -eq 0 ]; then
  echo "ERROR: No SSH rules found"
  exit 1
fi

echo ""
echo "Select your user:"
echo "----------------------------"
for i in $(seq 0 $((RULE_COUNT - 1))); do
  DESC=$(echo "$RULES_JSON" | jq -r ".[$i][2] // \"(no description)\"")
  IP=$(echo "$RULES_JSON" | jq -r ".[$i][1]" | sed 's|/32||')
  echo "  $((i + 1)). $DESC (current IP: $IP)"
done
echo ""

read -rp "Enter number (1-$RULE_COUNT): " CHOICE

if ! [[ "$CHOICE" =~ ^[0-9]+$ ]] || [ "$CHOICE" -lt 1 ] || [ "$CHOICE" -gt "$RULE_COUNT" ]; then
  echo "ERROR: Invalid selection"
  exit 1
fi

IDX=$((CHOICE - 1))
RULE_ID=$(echo "$RULES_JSON" | jq -r ".[$IDX][0]")
OLD_IP=$(echo "$RULES_JSON" | jq -r ".[$IDX][1]")
DESCRIPTION=$(echo "$RULES_JSON" | jq -r ".[$IDX][2]")

OLD_IP_CLEAN=$(echo "$OLD_IP" | sed 's|/32||')

echo ""
echo "Selected: $DESCRIPTION"

# Get current public IP
CURRENT_IP=$(curl -4 -s ifconfig.me)
if [ -z "$CURRENT_IP" ]; then
  echo "ERROR: Could not detect your public IP"
  exit 1
fi

if [ "$CURRENT_IP" = "$OLD_IP_CLEAN" ]; then
  echo "IP unchanged ($CURRENT_IP) — no update needed"
  exit 0
fi

echo "IP changed: $OLD_IP_CLEAN -> $CURRENT_IP"
echo "Updating security group..."

# Update the rule
aws ec2 modify-security-group-rules \
  --group-id "$SECURITY_GROUP_ID" \
  --security-group-rules "SecurityGroupRuleId=$RULE_ID,SecurityGroupRule={IpProtocol=tcp,FromPort=22,ToPort=22,CidrIpv4=$CURRENT_IP/32,Description=$DESCRIPTION}" \
  --region "$REGION" 2>&1

if [ $? -eq 0 ]; then
  echo "Updated SSH access for $DESCRIPTION to $CURRENT_IP"
  echo "Testing SSH..."
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$SSH_USER@$SSH_HOST" "echo 'SSH OK'" 2>&1
else
  echo "ERROR: Failed to update security group"
  exit 1
fi

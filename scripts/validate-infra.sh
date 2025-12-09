#!/bin/bash

# Infrastructure Validation Script
# Scans repos folder and validates all configurations are in place
# Usage: ./scripts/validate-infra.sh [--env staging|prod]

set -e

INFRASTRUCTURE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPOS_DIR="${INFRASTRUCTURE_ROOT}/repos"
SECRETS_DIR="${INFRASTRUCTURE_ROOT}/secrets"
NGINX_CONF="${INFRASTRUCTURE_ROOT}/nginx/nginx.conf"
DOCKER_COMPOSE="${INFRASTRUCTURE_ROOT}/docker-compose.yml"
ACTIONS_RUNNER_DIR="${INFRASTRUCTURE_ROOT}/actions-runner"
INFRA_CONF="${INFRASTRUCTURE_ROOT}/infra.conf"
CONFIG_FILE="${INFRASTRUCTURE_ROOT}/infrastructure-config.yml"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counters
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

# Parse arguments
ENV_OVERRIDE=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --env)
            ENV_OVERRIDE="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [--env staging|prod]"
            echo ""
            echo "Options:"
            echo "  --env    Override environment (staging or prod)"
            echo "           If not specified, reads from infra.conf"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Get environment from infra.conf or override
if [ -n "$ENV_OVERRIDE" ]; then
    INFRA_ENV="$ENV_OVERRIDE"
elif [ -f "$INFRA_CONF" ]; then
    source "$INFRA_CONF"
else
    echo -e "${RED}Error: infra.conf not found and no --env specified${NC}"
    echo "Create infra.conf with: INFRA_ENV=staging (or prod)"
    exit 1
fi

# Validate environment value
if [ "$INFRA_ENV" != "staging" ] && [ "$INFRA_ENV" != "prod" ]; then
    echo -e "${RED}Error: INFRA_ENV must be 'staging' or 'prod', got: $INFRA_ENV${NC}"
    exit 1
fi

# Helper functions
pass() {
    echo -e "  ${GREEN}✓${NC} $1"
    ((PASS_COUNT++))
}

fail() {
    echo -e "  ${RED}✗${NC} $1"
    ((FAIL_COUNT++))
}

warn() {
    echo -e "  ${YELLOW}!${NC} $1"
    ((WARN_COUNT++))
}

# Get list of repos from repos directory
get_repos() {
    local repos=()
    if [ -d "$REPOS_DIR" ]; then
        for dir in "$REPOS_DIR"/*/; do
            if [ -d "$dir" ]; then
                repo_name=$(basename "$dir")
                # Skip hidden directories
                if [[ ! "$repo_name" =~ ^\. ]]; then
                    repos+=("$repo_name")
                fi
            fi
        done
    fi
    echo "${repos[@]}"
}

# Get repos defined in docker-compose.yml
get_docker_compose_repos() {
    if [ -f "$DOCKER_COMPOSE" ]; then
        # Extract service names that end with -staging or -prod
        grep -E "^  [a-z].*-(staging|prod):" "$DOCKER_COMPOSE" 2>/dev/null | \
            sed 's/://g' | sed 's/^ *//' | \
            sed 's/-staging$//' | sed 's/-prod$//' | \
            sort -u
    fi
}

# Check if service exists in docker-compose.yml
check_docker_compose_service() {
    local service_name="$1"
    grep -q "^  ${service_name}:" "$DOCKER_COMPOSE" 2>/dev/null
}

# Check if nginx has server block for domain
check_nginx_config() {
    local domain="$1"
    grep -q "server_name.*${domain}" "$NGINX_CONF" 2>/dev/null
}

# Main validation
echo ""
echo "========================================"
echo "Infrastructure Validation ($INFRA_ENV)"
echo "========================================"
echo ""

# Discover repos from multiple sources
echo "Discovering repos..."
REPOS_FROM_DIR=($(get_repos))
REPOS_FROM_COMPOSE=($(get_docker_compose_repos))

# Combine and deduplicate
ALL_REPOS=($(echo "${REPOS_FROM_DIR[@]}" "${REPOS_FROM_COMPOSE[@]}" | tr ' ' '\n' | sort -u | tr '\n' ' '))

if [ ${#ALL_REPOS[@]} -eq 0 ]; then
    echo -e "${YELLOW}No repos found in repos/ directory or docker-compose.yml${NC}"
    echo "Run ./scripts/setup-repo.sh to add repos"
else
    echo "Repos found: ${ALL_REPOS[*]}"
fi
echo ""

# Validate each repo
for repo in "${ALL_REPOS[@]}"; do
    [ -z "$repo" ] && continue
    
    echo "[$repo]"
    
    # Check repo directory exists
    REPO_PATH="${REPOS_DIR}/${repo}"
    if [ -d "$REPO_PATH" ]; then
        pass "Repo cloned at repos/${repo}/"
    else
        fail "Repo not cloned - run: ./scripts/setup-repo.sh ${repo} <git-url>"
    fi
    
    # Check Dockerfile exists
    DOCKERFILE="${REPO_PATH}/apps/server/Dockerfile"
    if [ -f "$DOCKERFILE" ]; then
        pass "Dockerfile exists"
    elif [ -d "$REPO_PATH" ]; then
        fail "Dockerfile missing at apps/server/Dockerfile"
    fi
    
    # Check deploy workflow exists
    WORKFLOW="${REPO_PATH}/.github/workflows/deploy.yml"
    if [ -f "$WORKFLOW" ]; then
        pass "Deploy workflow exists"
    elif [ -d "$REPO_PATH" ]; then
        warn "Deploy workflow missing at .github/workflows/deploy.yml"
    fi
    
    # Check environment file exists
    ENV_FILE="${SECRETS_DIR}/${repo}-${INFRA_ENV}.env"
    if [ -f "$ENV_FILE" ]; then
        pass "Env file: secrets/${repo}-${INFRA_ENV}.env"
    else
        fail "Env file missing: secrets/${repo}-${INFRA_ENV}.env"
    fi
    
    # Check docker-compose service
    SERVICE_NAME="${repo}-${INFRA_ENV}"
    if check_docker_compose_service "$SERVICE_NAME"; then
        pass "Docker Compose service: ${SERVICE_NAME}"
    else
        fail "Docker Compose service missing: ${SERVICE_NAME}"
    fi
    
    # Check nginx configuration
    if [ "$INFRA_ENV" = "staging" ]; then
        DOMAIN="staging-${repo}.greasemoto.com"
        # Handle special case for chop-shop which uses api.greasemoto.com
        if [ "$repo" = "chop-shop" ]; then
            DOMAIN="staging-api.greasemoto.com"
        fi
    else
        DOMAIN="${repo}.greasemoto.com"
        if [ "$repo" = "chop-shop" ]; then
            DOMAIN="api.greasemoto.com"
        fi
    fi
    
    if check_nginx_config "$DOMAIN"; then
        pass "Nginx configured for ${DOMAIN}"
    else
        fail "Nginx server block missing for ${DOMAIN}"
    fi
    
    echo ""
done

# Check GitHub Actions Runner status
echo "Runner Status"
echo "-------------"

if [ -d "$ACTIONS_RUNNER_DIR" ]; then
    if [ -f "${ACTIONS_RUNNER_DIR}/svc.sh" ]; then
        # Try to get runner status
        RUNNER_STATUS=$(cd "$ACTIONS_RUNNER_DIR" && ./svc.sh status 2>&1) || true
        
        if echo "$RUNNER_STATUS" | grep -qi "running"; then
            pass "GitHub Actions runner is running"
        elif echo "$RUNNER_STATUS" | grep -qi "stopped\|not running\|inactive"; then
            fail "GitHub Actions runner is stopped - run: cd actions-runner && ./svc.sh start"
        else
            warn "Runner status unknown: $RUNNER_STATUS"
        fi
    elif [ -f "${ACTIONS_RUNNER_DIR}/config.sh" ]; then
        warn "Runner downloaded but not configured - run: cd actions-runner && ./config.sh"
    else
        warn "Runner not installed - see INITIAL_SETUP.md step 7"
    fi
else
    fail "actions-runner directory not found"
fi

echo ""

# Check certbot domains in docker-compose
echo "SSL Certificates"
echo "----------------"
if [ -f "$DOCKER_COMPOSE" ]; then
    CERTBOT_LINE=$(grep -A1 "certbot:" "$DOCKER_COMPOSE" | grep "command:" || grep "certonly" "$DOCKER_COMPOSE" || echo "")
    if [ -n "$CERTBOT_LINE" ]; then
        for repo in "${ALL_REPOS[@]}"; do
            [ -z "$repo" ] && continue
            
            if [ "$INFRA_ENV" = "staging" ]; then
                DOMAIN="staging-${repo}.greasemoto.com"
                if [ "$repo" = "chop-shop" ]; then
                    DOMAIN="staging-api.greasemoto.com"
                fi
            else
                DOMAIN="${repo}.greasemoto.com"
                if [ "$repo" = "chop-shop" ]; then
                    DOMAIN="api.greasemoto.com"
                fi
            fi
            
            if echo "$CERTBOT_LINE" | grep -q "$DOMAIN"; then
                pass "Certbot configured for ${DOMAIN}"
            else
                warn "Certbot may not include ${DOMAIN} - check docker-compose.yml certbot command"
            fi
        done
    else
        warn "Certbot command not found in docker-compose.yml"
    fi
fi

echo ""

# Summary
echo "========================================"
echo "Summary"
echo "========================================"
TOTAL=$((PASS_COUNT + FAIL_COUNT + WARN_COUNT))
echo -e "${GREEN}Passed:${NC}   ${PASS_COUNT}"
echo -e "${RED}Failed:${NC}   ${FAIL_COUNT}"
echo -e "${YELLOW}Warnings:${NC} ${WARN_COUNT}"
echo ""

if [ $FAIL_COUNT -eq 0 ]; then
    echo -e "${GREEN}All critical checks passed!${NC}"
    exit 0
else
    echo -e "${RED}${FAIL_COUNT} critical issue(s) found. See above for details.${NC}"
    exit 1
fi

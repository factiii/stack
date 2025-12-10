#!/bin/bash

# RDS Backup Script
# Backs up RDS databases to Mac Mini daily
# Usage: ./scripts/backup-all-dbs.sh

set -e

# Configuration
BACKUP_DIR="${HOME}/rds-backups"
RETENTION_DAYS=30
DATE=$(date +%Y%m%d_%H%M%S)

# Database list - configure your RDS databases here
# Format: DB_NAME:DB_HOST:DB_PORT:DB_USER:DB_NAME
# Example: mydb:my-rds-instance.region.rds.amazonaws.com:5432:postgres:mydb
DATABASES=(
    # Add your RDS databases here
    # "db1:host1.rds.amazonaws.com:5432:user1:db1"
    # "db2:host2.rds.amazonaws.com:5432:user2:db2"
)

# Load database config from environment if available
if [ -f "${HOME}/.rds-backup-config" ]; then
    source "${HOME}/.rds-backup-config"
fi

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

echo "🗄️  Starting RDS backup process..."
echo "Backup directory: $BACKUP_DIR"
echo "Retention: $RETENTION_DAYS days"

# Check if pg_dump is available
if ! command -v pg_dump &> /dev/null; then
    echo "Error: pg_dump not found. Install PostgreSQL client tools."
    exit 1
fi

# Function to backup a single database
backup_database() {
    local db_config=$1
    IFS=':' read -r db_name db_host db_port db_user db_name_actual <<< "$db_config"
    
    if [ -z "$db_name" ] || [ -z "$db_host" ]; then
        echo "⚠️  Skipping invalid database config: $db_config"
        return
    fi
    
    local backup_file="${BACKUP_DIR}/${db_name}_${DATE}.sql.gz"
    local pgpassword="${PGPASSWORD:-}"
    
    echo "📦 Backing up ${db_name} from ${db_host}..."
    
    # Use PGPASSWORD environment variable if set, otherwise prompt
    if [ -z "$pgpassword" ]; then
        echo "⚠️  PGPASSWORD not set. You may be prompted for password."
    fi
    
    # Build connection string
    local conn_string="postgresql://${db_user}@${db_host}:${db_port:-5432}/${db_name_actual:-$db_name}"
    
    # Perform backup with compression
    if PGPASSWORD="$pgpassword" pg_dump "$conn_string" | gzip > "$backup_file"; then
        local size=$(du -h "$backup_file" | cut -f1)
        echo "✅ Backup completed: $backup_file (${size})"
    else
        echo "❌ Backup failed for ${db_name}"
        rm -f "$backup_file"
        return 1
    fi
}

# Backup all databases
if [ ${#DATABASES[@]} -eq 0 ]; then
    echo "⚠️  No databases configured. Add databases to DATABASES array in this script"
    echo "   or create ~/.rds-backup-config with DATABASES array"
    exit 0
fi

FAILED_BACKUPS=0
for db_config in "${DATABASES[@]}"; do
    if ! backup_database "$db_config"; then
        FAILED_BACKUPS=$((FAILED_BACKUPS + 1))
    fi
done

# Clean up old backups
echo "🧹 Cleaning up backups older than $RETENTION_DAYS days..."
find "$BACKUP_DIR" -name "*.sql.gz" -type f -mtime +$RETENTION_DAYS -delete
echo "✅ Cleanup complete"

# Summary
echo ""
echo "📊 Backup Summary:"
echo "   Total databases: ${#DATABASES[@]}"
echo "   Successful: $((${#DATABASES[@]} - FAILED_BACKUPS))"
echo "   Failed: $FAILED_BACKUPS"

if [ $FAILED_BACKUPS -gt 0 ]; then
    exit 1
fi

echo "✅ All backups completed successfully!"


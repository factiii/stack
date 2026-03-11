# AWS EC2 Deployment — Setup Guide

This guide explains everything you need to do **before** `npx factiii fix` can take over and provision your AWS infrastructure.

## Overview

Factiii automates AWS deployment in two commands:

```bash
npx factiii fix           # Provisions VPC, Security Groups, EC2, RDS, S3, ECR, IAM
npx factiii deploy --prod # Configures Docker, Nginx, SSL, pulls images, starts containers
```

But first, you need to create an IAM user and configure the AWS CLI — a one-time setup that takes about 5 minutes.

---

## Prerequisites

### Step 1: Create an AWS Account

If you don't already have one, sign up at [https://aws.amazon.com](https://aws.amazon.com).

The free tier covers everything factiii provisions by default (EC2 `t3.micro`, RDS `db.t3.micro`, 5GB S3, 500MB ECR).

### Step 2: Install AWS CLI

```bash
# macOS
brew install awscli

# Windows
winget install Amazon.AWSCLI

# Linux
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip && sudo ./aws/install
```

Verify installation:
```bash
aws --version
# aws-cli/2.x.x ...
```

### Step 3: Create an IAM User

1. Go to **[AWS Console → IAM → Users](https://console.aws.amazon.com/iam/home#/users)**
2. Click **"Create user"**
3. User name: **`factiii-admin`**
4. Click **"Attach policies directly"**
5. Click **"Create policy"** → switch to the **JSON** tab
6. Paste the policy below (or copy from `src/plugins/pipelines/aws/policies/bootstrap-policy.json`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "FactiiiEC2Full",
      "Effect": "Allow",
      "Action": [
        "ec2:CreateVpc",
        "ec2:DeleteVpc",
        "ec2:DescribeVpcs",
        "ec2:ModifyVpcAttribute",
        "ec2:CreateSubnet",
        "ec2:DeleteSubnet",
        "ec2:DescribeSubnets",
        "ec2:ModifySubnetAttribute",
        "ec2:CreateInternetGateway",
        "ec2:DeleteInternetGateway",
        "ec2:AttachInternetGateway",
        "ec2:DetachInternetGateway",
        "ec2:DescribeInternetGateways",
        "ec2:CreateRouteTable",
        "ec2:DeleteRouteTable",
        "ec2:CreateRoute",
        "ec2:AssociateRouteTable",
        "ec2:DescribeRouteTables",
        "ec2:CreateSecurityGroup",
        "ec2:DeleteSecurityGroup",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:RevokeSecurityGroupIngress",
        "ec2:DescribeSecurityGroups",
        "ec2:CreateKeyPair",
        "ec2:DeleteKeyPair",
        "ec2:DescribeKeyPairs",
        "ec2:RunInstances",
        "ec2:TerminateInstances",
        "ec2:DescribeInstances",
        "ec2:AllocateAddress",
        "ec2:ReleaseAddress",
        "ec2:AssociateAddress",
        "ec2:DescribeAddresses",
        "ec2:DescribeAvailabilityZones",
        "ec2:DescribeImages",
        "ec2:CreateTags"
      ],
      "Resource": "*"
    },
    {
      "Sid": "FactiiiRDSFull",
      "Effect": "Allow",
      "Action": [
        "rds:CreateDBInstance",
        "rds:DeleteDBInstance",
        "rds:DescribeDBInstances",
        "rds:CreateDBSubnetGroup",
        "rds:DeleteDBSubnetGroup",
        "rds:DescribeDBSubnetGroups",
        "rds:AddTagsToResource",
        "rds:ListTagsForResource"
      ],
      "Resource": "*"
    },
    {
      "Sid": "FactiiiS3Full",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:DeleteBucket",
        "s3:ListBucket",
        "s3:PutBucketEncryption",
        "s3:PutBucketPublicAccessBlock",
        "s3:PutBucketCORS",
        "s3:GetBucketEncryption",
        "s3:GetBucketPublicAccessBlock",
        "s3:GetBucketCORS",
        "s3:PutObject",
        "s3:GetObject",
        "s3:ListAllMyBuckets"
      ],
      "Resource": "*"
    },
    {
      "Sid": "FactiiiECRFull",
      "Effect": "Allow",
      "Action": [
        "ecr:CreateRepository",
        "ecr:DeleteRepository",
        "ecr:DescribeRepositories",
        "ecr:GetAuthorizationToken",
        "ecr:PutLifecyclePolicy",
        "ecr:BatchGetImage",
        "ecr:BatchCheckLayerAvailability",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload"
      ],
      "Resource": "*"
    },
    {
      "Sid": "FactiiiSES",
      "Effect": "Allow",
      "Action": [
        "ses:VerifyDomainIdentity",
        "ses:VerifyDomainDkim",
        "ses:GetAccountSendingEnabled",
        "ses:GetIdentityVerificationAttributes",
        "ses:GetIdentityDkimAttributes"
      ],
      "Resource": "*"
    },
    {
      "Sid": "FactiiiIAMLimited",
      "Effect": "Allow",
      "Action": [
        "iam:CreateUser",
        "iam:DeleteUser",
        "iam:GetUser",
        "iam:PutUserPolicy",
        "iam:DeleteUserPolicy",
        "iam:CreateAccessKey",
        "iam:ListAccessKeys",
        "iam:ListUsers"
      ],
      "Resource": "*"
    },
    {
      "Sid": "FactiiiSTS",
      "Effect": "Allow",
      "Action": [
        "sts:GetCallerIdentity"
      ],
      "Resource": "*"
    }
  ]
}
```

7. Click **"Next"** → Name the policy: **`factiii-bootstrap`** → **"Create policy"**
8. Go back to the user creation, **refresh** the policy list, search for **`factiii-bootstrap`**, and attach it
9. **Create the user**
10. Go to the user → **"Security credentials"** → **"Create access key"** → Select **"Command Line Interface (CLI)"**
11. **Save both the Access Key ID and Secret Access Key** — you'll need them in the next step

### Step 4: Configure AWS CLI

```bash
aws configure
```

Enter these values when prompted:

| Prompt | Value |
|---|---|
| AWS Access Key ID | `AKIA...` (from Step 3) |
| AWS Secret Access Key | `wJalr...` (from Step 3) |
| Default region name | `us-east-1` (or your preferred region) |
| Default output format | `json` |

Verify it works:
```bash
aws sts get-caller-identity
# Should return your account ID and IAM user ARN
```

### Step 5: Configure `stack.yml`

In your project root, edit `stack.yml` and update the prod section:

```yaml
name: your-repo-name
ssl_email: admin@yourdomain.com

prod:
  server: ubuntu
  pipeline: aws
  domain: yourdomain.com          # Your actual domain
  config: free-tier               # ec2 | free-tier
  access_key_id: AKIA...          # Your access key ID (not the secret)
  region: us-east-1               # Must match aws configure region
```

> **Note:** Only the access key ID goes in `stack.yml` (committed to git). The secret access key is stored securely via `aws configure` or Ansible Vault.

---

## Run Factiii

Now factiii can take over:

```bash
# Step 1: Provision everything
npx factiii fix

# This creates:
#   ✅ VPC with public/private subnets
#   ✅ Internet Gateway + route tables
#   ✅ Security Groups (SSH, HTTP/HTTPS, RDS)
#   ✅ EC2 Key Pair (SSH key stored in Ansible Vault)
#   ✅ EC2 Instance (Ubuntu 22.04, t3.micro)
#   ✅ Elastic IP (static public IP)
#   ✅ RDS Database (PostgreSQL, db.t3.micro)
#   ✅ S3 Bucket (encrypted, private)
#   ✅ ECR Repository (Docker images)
#   ✅ IAM Users (dev + prod with scoped policies)
#   ✅ SES Email (domain verification + DKIM)

# Step 2: Deploy your application
npx factiii deploy --prod

# This configures:
#   ✅ Docker + Docker Compose on EC2
#   ✅ Nginx reverse proxy with SSL
#   ✅ Let's Encrypt certificates (auto-renewal)
#   ✅ Pulls Docker image from ECR
#   ✅ Starts application containers
#   ✅ Health check verification
```

---

## What Gets Provisioned

| Resource | Details | Free Tier |
|---|---|---|
| VPC | 10.0.0.0/16 with public + private subnets | ✅ Free |
| EC2 | Ubuntu 22.04 LTS, t3.micro, 30GB EBS | ✅ 750 hrs/mo |
| RDS | PostgreSQL, db.t3.micro, 20GB | ✅ 750 hrs/mo |
| S3 | Encrypted bucket, private access | ✅ 5GB |
| ECR | Docker image repository | ✅ 500MB |
| SES | Email sending + domain verification | ✅ 62K emails/mo |
| Elastic IP | Static public IP for EC2 | ✅ Free (when attached) |

---

## Troubleshooting

### "AWS CLI not installed or not configured"
Run `aws configure` and enter your credentials from Step 3.

### "AWS credentials are invalid or expired"
```bash
aws sts get-caller-identity
```
If this fails, regenerate access keys in AWS Console → IAM → Users → Security credentials.

### "EC2 instance not created"
Ensure your IAM user has the `factiii-bootstrap` policy attached. Check with:
```bash
aws iam list-attached-user-policies --user-name factiii-admin
```

### SSH connection fails after EC2 is created
The SSH key is automatically stored in Ansible Vault. Make sure you have the vault password configured:
```bash
# Check if vault is accessible
npx stack deploy --secrets list
```

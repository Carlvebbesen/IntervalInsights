To install dependencies:

```sh
bun install
```

## Environment Variables

Create a `.env` file in the root directory with the following variables:

### Required Environment Variables

```bash
# Database Configuration
# Format: postgresql://username:password@host:port/database
# For local development with docker-compose:
DATABASE_URL=postgresql://interval_user:interval_password@localhost:5432/interval_insights_dev

# Clerk Authentication
# Get your secret key from: https://dashboard.clerk.com/apps
CLERK_SECRET_KEY=sk_test_...

# Strava OAuth Configuration
# Create an app at: https://www.strava.com/settings/api
STRAVA_CLIENT_ID=your_strava_client_id
STRAVA_CLIENT_SECRET=your_strava_client_secret

# Strava Webhook Configuration
# This token is used to verify webhook requests from Strava
# You can use any random string (e.g., generate with: openssl rand -hex 32)
STRAVA_WEBHOOK_VERIFY_TOKEN=your_random_webhook_verify_token

# Application Base URL
# Used for webhook callbacks and OAuth redirects
# For local development:
APP_BASE_URL=http://localhost:3000
# For production, use your actual domain:
# APP_BASE_URL=https://yourdomain.com
```

### Setting Up

1. **Database**: Start PostgreSQL using docker-compose:

   ```sh
   docker-compose up -d
   ```

2. **Clerk**:

   - Sign up at https://clerk.com
   - Create a new application
   - Copy the Secret Key from the API Keys section

3. **Strava**:

   - Go to https://www.strava.com/settings/api
   - Create a new application
   - Set the Authorization Callback Domain to your domain (or `localhost` for development)
   - Copy the Client ID and Client Secret
   - Generate a random webhook verify token

4. **Database Migrations**:
   ```sh
   bun run db:generate  # Generate migration files
   bun run db:push      # Push schema to database (or use db:migrate)
   ```

To run:

```sh
bun run dev
```

open http://localhost:3000

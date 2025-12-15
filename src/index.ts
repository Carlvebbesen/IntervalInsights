import { clerkMiddleware, getAuth } from '@hono/clerk-auth'
import { Hono } from 'hono'
import { cors } from 'hono/cors';
import stravaAuthEndpoints from './routers/strava_auth_router';
import stravaEndpoints from './routers/strava_router';
import { createMiddleware } from 'hono/factory';

export type Bindings ={
}

const app = new Hono<{Bindings: Bindings}>()

app.use('*', clerkMiddleware())
app.use('*', cors());
const authGuard = createMiddleware(async (c, next) => {
  const auth = getAuth(c);

  if (!auth?.userId) {
    return c.json({ error: 'Unauthorized: Guard: You must be logged in.' }, 401);
  }
  c.set('userId', auth.userId);

  await next();
});


// --- 3. Apply Guard Globally or Per-Route ---

// OPTION A: Protect EVERYTHING below this line
app.use('*', authGuard);

app.get('/', (c) => {
  const auth = getAuth(c)

  if (!auth?.userId) {
    return c.json({
      message: 'You are not logged in.',
    })
  }

  return c.json({
    message: 'You are logged in!',
    userId: auth.userId,
  })
})
app.route("/strava/auth", stravaAuthEndpoints);
app.route("/strava", stravaEndpoints);

export default app



// import { clerkMiddleware, getAuth } from '@hono/clerk-auth'
// import { Hono } from 'hono'

// const app = new Hono()

// app.use('*', clerkMiddleware())
// app.get('/', async (c) => {
//   const clerkClient = c.get('clerk')

//   try {
//     const user = await clerkClient.users.getUser('user_id_....')

//     return c.json({
//       user,
//     })
//   } catch (e) {
//     return c.json(
//       {
//         message: 'User not found.',
//       },
//       404
//     )
//   }
// })

// export default app
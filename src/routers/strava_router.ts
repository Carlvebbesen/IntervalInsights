import {  Hono } from "hono";
import { Bindings } from "..";
import { stravaMiddleware } from "../middlewares/strava_middleware";

type Variables = {
  stravaAccessToken: string;
}

// Update Hono initialization to include Bindings and Variables
const stravaEndpoints = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// --- APPLY MIDDLEWARE ---
// Apply to all routes in this router
stravaEndpoints.use('*', stravaMiddleware);


/**
 * Endpoint 3: Get Gear by ID
 * Note: We removed the manual Auth Header check because the middleware handles it now!
 */
stravaEndpoints.get('/gear/:id', async (c) => {
  const gearId = c.req.param('id');
  
  // Retrieve token set by middleware
  const accessToken = c.get('stravaAccessToken'); 

  try {
    const response = await fetch(`https://www.strava.com/api/v3/gear/${gearId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      const errorData = await response.json();
      return c.json({ error: 'Failed to fetch gear', details: errorData }, response.status as any);
    }

    const gearData = await response.json();
    return c.json(gearData);

  } catch (error) {
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});


/**
 * Endpoint 4: Get Route by ID
 * Returns a route using its identifier.
 * Note: Requires 'read_all' scope if the route is private.
 * Usage: GET /strava/routes/12345
 * Headers: Authorization: Bearer <STRAVA_ACCESS_TOKEN>
 */
stravaEndpoints.get('/routes/:id', async (c) => {
  const routeId = c.req.param('id');
  
  // 1. Get the Strava Access Token from the request headers
  const authHeader = c.req.header('Authorization');

  if (!authHeader) {
    return c.json({ error: 'Missing Authorization header with Strava Token' }, 401);
  }

  try {
    // 2. Call Strava API
    const response = await fetch(`https://www.strava.com/api/v3/routes/${routeId}`, {
      method: 'GET',
      headers: {
        'Authorization': authHeader
      }
    });

    // 3. Handle Errors (e.g. Private route without permission)
    if (!response.ok) {
      const errorData = await response.json();
      console.error('Strava Route Error:', errorData);
      
      // Pass the Strava status code (e.g., 403 or 404) back to the client
      return c.json(
        { error: 'Failed to fetch route from Strava', details: errorData }, 
        response.status as any
      );
    }

    // 4. Return the Route Data
    const routeData = await response.json();
    return c.json(routeData);

  } catch (error) {
    console.error('Worker Error:', error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

/**
 * Endpoint 5: Get Activity by ID
 * Returns the given activity owned by the authenticated athlete.
 * * Scopes Required: 
 * - 'activity:read' (for public activities)
 * - 'activity:read_all' (for 'Only Me' private activities)
 * * Usage: GET /strava/activities/12345678?include_all_efforts=true
 * Headers: Authorization: Bearer <STRAVA_ACCESS_TOKEN>
 */
stravaEndpoints.get('/activities/:id', async (c) => {
  const activityId = c.req.param('id');
  const includeEfforts = c.req.query('include_all_efforts'); // Optional query param
  
  // 1. Get the Strava Access Token from headers
  const authHeader = c.req.header('Authorization');

  if (!authHeader) {
    return c.json({ error: 'Missing Authorization header with Strava Token' }, 401);
  }

  try {
    // 2. Build the Strava URL with query parameters
    const stravaUrl = new URL(`https://www.strava.com/api/v3/activities/${activityId}`);
    
    // If the client passed 'include_all_efforts', forward it to Strava
    if (includeEfforts) {
      stravaUrl.searchParams.append('include_all_efforts', includeEfforts);
    }

    // 3. Call Strava API
    const response = await fetch(stravaUrl.toString(), {
      method: 'GET',
      headers: {
        'Authorization': authHeader
      }
    });

    // 4. Handle Errors
    if (!response.ok) {
      const errorData = await response.json();
      console.error('Strava Activity Error:', errorData);
      return c.json(
        { error: 'Failed to fetch activity from Strava', details: errorData }, 
        response.status as any
      );
    }

    // 5. Return the Activity Data
    const activityData = await response.json();
    return c.json(activityData);

  } catch (error) {
    console.error('Worker Error:', error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});


/**
 * Endpoint 6: Get Activity Streams
 * Returns the raw data streams (coords, watts, heartrate, etc.) for an activity.
 * * * Usage: GET /strava/activities/12345/streams?keys=time,distance,latlng,watts,heartrate
 * * Note: 'key_by_type=true' is automatically appended by this worker.
 * Headers: Authorization: Bearer <STRAVA_ACCESS_TOKEN>
 */
stravaEndpoints.get('/activities/:id/streams', async (c) => {
  const activityId = c.req.param('id');
  
  // 1. Capture 'keys' from the query string (e.g. ?keys=time,distance,latlng)
  const keys = c.req.query('keys');
  
  // 2. Get Auth Header
  const authHeader = c.req.header('Authorization');

  if (!authHeader) {
    return c.json({ error: 'Missing Authorization header with Strava Token' }, 401);
  }

  if (!keys) {
    return c.json({ error: 'Missing required query parameter: keys (e.g. ?keys=time,distance)' }, 400);
  }

  try {
    // 3. Construct Strava URL
    // We strictly enforce key_by_type=true as per API requirements
    const stravaUrl = `https://www.strava.com/api/v3/activities/${activityId}/streams?keys=${keys}&key_by_type=true`;

    // 4. Call Strava
    const response = await fetch(stravaUrl, {
      method: 'GET',
      headers: {
        'Authorization': authHeader
      }
    });

    // 5. Handle Errors
    if (!response.ok) {
      const errorData = await response.json();
      console.error('Strava Streams Error:', errorData);
      return c.json(
        { error: 'Failed to fetch streams', details: errorData }, 
        response.status as any
      );
    }

    // 6. Return Data
    const streamData = await response.json();
    return c.json(streamData);

  } catch (error) {
    console.error('Worker Error:', error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

export default stravaEndpoints;



export default async (request, context) => {
    // 1. Setup CORS so your app can talk to this endpoint
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
        return new Response("ok", { status: 200, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const deviceId = url.searchParams.get("deviceId");
    
    // Capture which app is making the request (defaults to 'yolo')
    const appName = url.searchParams.get("app") || "yolo";

    if (!deviceId) {
        return new Response(JSON.stringify({success: false, msg: "Missing deviceId"}), { status: 400, headers: corsHeaders });
    }

    // 2. Load keys from Netlify Environment Variables
    const LARK_APP_ID = Netlify.env.get("LARK_APP_ID");
    const LARK_APP_SECRET = Netlify.env.get("LARK_APP_SECRET");
    const LARK_APP_TOKEN = Netlify.env.get("LARK_APP_TOKEN");
    const LARK_SYNC_TABLE_ID = Netlify.env.get("LARK_SYNC_TABLE_ID"); // For saving profiles
    const LARK_LICENSE_TABLE_ID = Netlify.env.get("LARK_LICENSE_TABLE_ID"); // For verifying users

    if (!LARK_APP_SECRET || !LARK_LICENSE_TABLE_ID || !LARK_SYNC_TABLE_ID) {
        return new Response(JSON.stringify({success: false, msg: "Server missing Env Vars"}), {status: 500, headers: corsHeaders});
    }

    try {
        // 3. Fetch Authorization Token from Lark
        const tokenRes = await fetch("https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ app_id: LARK_APP_ID, app_secret: LARK_APP_SECRET })
        });
        const tokenData = await tokenRes.json();
        const token = tokenData.tenant_access_token;

        // ==========================================================
        // SECURITY CHECK: Verify the user in the License Table First
        // ==========================================================
        const licenseRes = await fetch(`https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_APP_TOKEN}/tables/${LARK_LICENSE_TABLE_ID}/records/search`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                filter: { conjunction: "and", conditions: [{ field_name: "Device ID", operator: "is", value: [deviceId] }] }
            })
        });
        const licenseData = await licenseRes.json();
        const licenseRecord = licenseData.data?.items?.[0];

        let isLicensed = false;
        if (licenseRecord) {
            const statusRaw = licenseRecord.fields["Status"];
            let statusStr = typeof statusRaw === 'object' && statusRaw !== null ? (statusRaw.text || JSON.stringify(statusRaw)) : String(statusRaw || "");
            
            // If the user's status in the database includes "Active", they pass the check.
            if (statusStr.toLowerCase().includes("active")) {
                isLicensed = true;
            }
        }

        // Reject if not an active user
        if (!isLicensed) {
            return new Response(JSON.stringify({success: false, msg: "Unauthorized: No active license found for this Device ID."}), { status: 403, headers: corsHeaders });
        }
        // ==========================================================

        // 4. Search if user already has a backup in the CloudSync table for THIS SPECIFIC APP
        const searchRes = await fetch(`https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_APP_TOKEN}/tables/${LARK_SYNC_TABLE_ID}/records/search`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ 
                filter: { 
                    conjunction: "and", 
                    conditions: [
                        { field_name: "Device ID", operator: "is", value: [deviceId] },
                        { field_name: "App Name", operator: "is", value: [appName] }
                    ] 
                } 
            })
        });
        const searchData = await searchRes.json();
        const existingRecord = searchData.data?.items?.[0];

        // --- HANDLE RESTORE (GET) ---
        if (request.method === "GET") {
            if (!existingRecord) return new Response(JSON.stringify({ success: false, msg: "No backup found for this app." }), { headers: corsHeaders });
            
            let profilesJson = existingRecord.fields["Profiles Data"];
            if (typeof profilesJson === 'object' && profilesJson !== null) {
                profilesJson = profilesJson[0]?.text || profilesJson.text || profilesJson;
            }
            
            return new Response(JSON.stringify({ success: true, data: profilesJson }), { headers: corsHeaders });
        }

        // --- HANDLE BACKUP (POST) ---
        if (request.method === "POST") {
            const body = await request.json();
            const profilesString = JSON.stringify(body.profiles);

            const payload = {
                fields: {
                    "Device ID": deviceId,
                    "App Name": appName,
                    "Profiles Data": profilesString,
                    "Last Synced": Date.now()
                }
            };

            if (existingRecord) {
                // Update existing row
                await fetch(`https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_APP_TOKEN}/tables/${LARK_SYNC_TABLE_ID}/records/${existingRecord.record_id}`, {
                    method: "PUT",
                    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
            } else {
                // Create new row
                await fetch(`https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_APP_TOKEN}/tables/${LARK_SYNC_TABLE_ID}/records`, {
                    method: "POST",
                    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
            }
            return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }

    } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: corsHeaders });
    }
};
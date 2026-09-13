// Supabase Edge Function — create-user
// Called by ADMIN to create a new user account server-side without displacing the admin session.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Build an admin client (service role — can create auth users)
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // 2. Verify the caller is an authenticated ADMIN
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Non autorisé" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: { user: caller }, error: authErr } = await serviceClient.auth.getUser(token);
    if (authErr || !caller) {
      return new Response(JSON.stringify({ error: "Non autorisé" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check ADMIN role
    const { data: roleRow } = await serviceClient
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.id)
      .eq("role", "ADMIN")
      .maybeSingle();
    if (!roleRow) {
      return new Response(JSON.stringify({ error: "Accès refusé — rôle ADMIN requis" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Parse body
    const { full_name, email, password, phone, role } = await req.json();
    if (!email || !password || !full_name) {
      return new Response(JSON.stringify({ error: "Champs obligatoires manquants (nom, email, mot de passe)" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. Create auth user (email_confirm: true so they can log in immediately)
    const { data: newAuthUser, error: createErr } = await serviceClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr || !newAuthUser.user) {
      return new Response(JSON.stringify({ error: createErr?.message ?? "Échec création compte" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const newUid = newAuthUser.user.id;

    // 5. Insert profile (the trigger may already do this, but we upsert to set full_name/phone)
    await serviceClient.from("profiles").upsert({
      user_id: newUid,
      email,
      full_name: full_name.trim(),
      phone: phone?.trim() || null,
      is_active: true,
    }, { onConflict: "user_id" });

    // 6. Insert role
    const chosenRole = role && ["ADMIN", "SURVEILLANT", "TECHNICIEN"].includes(role) ? role : "SURVEILLANT";
    await serviceClient.from("user_roles").insert({ user_id: newUid, role: chosenRole });

    // 7. Activity log
    await serviceClient.from("activity_logs").insert({
      user_id: caller.id,
      action: `Créé utilisateur ${full_name} (${chosenRole})`,
      entity: "profiles",
      entity_id: newUid,
    });

    return new Response(JSON.stringify({ ok: true, user_id: newUid }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message ?? "Erreur interne" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

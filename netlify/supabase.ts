import { createClient, processLock } from '@supabase/supabase-js';

const supabaseBaseURL = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

console.log('initiate supabase client');
// QF: Create client only with resolved env values (no direct process.env usage).

const supabase = createClient(supabaseBaseURL, supabaseAnonKey);

export default supabase;

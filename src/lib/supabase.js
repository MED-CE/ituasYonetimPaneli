import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error('VITE_SUPABASE_URL ve VITE_SUPABASE_PUBLISHABLE_KEY .env içinde bulunamadı.');
}

export const supabase = createClient(url, key);

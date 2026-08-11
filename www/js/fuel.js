/* fuel.js — Fuel pillar logic (SPEC §5): synced recipes + nutrition estimates,
   Vic's weekly meal plan (draft → agree → push to cookbook), photo food logging. */

import { settings, logs } from './store.js';
import { claude, parseJson } from './vic.js';
import { cloudAll, cloudUpsert, cloudPatch, signedIn } from './sync.js';

/* ---------- recipes & pantry (shared with the cookbook) ---------- */
/* Sorting moved client-side: the store is a JSON file now, not a queryable
   table, and these lists are tens of rows. */
const byTitle = (a, b) => String(a.title || '').localeCompare(String(b.title || ''));
const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
export async function fetchRecipes() {
  return (await cloudAll('shared_recipes')).sort(byTitle);
}
export async function fetchPantry() {
  return (await cloudAll('shared_pantry_items')).sort(byName);
}

/* AI nutrition estimate for one recipe, cached to shared_recipes.nutrition */
export async function estimateNutrition(recipeId) {
  const full = (await cloudAll('shared_recipes')).find(r => String(r.id) === String(recipeId));
  if (!full) throw new Error('Recipe not found.');
  const text = await claude(
    `Estimate per-serving nutrition for this recipe. Return ONLY JSON: ` +
    `{"kcal":int,"protein_g":int,"carbs_g":int,"fat_g":int,"servings_assumed":int}\n\n` +
    `Recipe "${full.title}":\n${JSON.stringify(full.recipe).slice(0, 6000)}`,
    { maxTokens: 300 });
  const nutrition = parseJson(text);
  await cloudPatch('shared_recipes', r => String(r.id) === String(recipeId), { nutrition });
  return nutrition;
}

/* ---------- weekly meal plan (SPEC §5.2) ---------- */
function mondayOf(d = new Date()) {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}

export async function draftMealPlan() {
  const profile = settings.profile;
  const [recipes, pantry] = await Promise.all([
    fetchRecipes().catch(() => []), fetchPantry().catch(() => []),
  ]);
  const text = await claude(
    `You are Vic, planning dinners for the week for a client whose goal is: ${profile.goal} ` +
    `(sustainable rate ${profile.targetRate}). Prefer their OWN recipes below; fill gaps with ` +
    `simple high-protein meals. Higher-carb on training days (assume Mon/Tue/Thu/Sat train). ` +
    `Use pantry items where possible. Return ONLY JSON:\n` +
    `{"week_start":"${mondayOf()}","days":[{"day":"Mon","meal":"...","recipe_id":"uuid or null","kcal":int}],` +
    `"shopping":[{"name":"...","quantity":"..."}]}\n` +
    `Shopping list = plan ingredients MINUS pantry. 7 days.\n\n` +
    `THEIR RECIPES (id, title, per-serving nutrition):\n` +
    recipes.map(r => `${r.id} | ${r.title} | ${JSON.stringify(r.nutrition || 'unknown')}`).join('\n').slice(0, 4000) +
    `\n\nPANTRY:\n` + pantry.map(p => `${p.name} ${p.quantity || ''}`).join(', ').slice(0, 1500),
    { maxTokens: 2500 });
  const plan = parseJson(text);
  if (!Array.isArray(plan.days) || !plan.days.length) throw new Error('Vic returned an unusable meal plan — try again.');
  return plan;
}

/* Agree the draft: store locally + push to the cookbook via shared tables */
export async function agreeMealPlan(plan) {
  await logs.add('mealplans', { plan, agreed: true });
  if (!signedIn()) return { pushed: false };
  await cloudUpsert('shared_meal_plans',
    [{ week_start: plan.week_start, plan: plan.days, agreed_at: new Date().toISOString() }],
    ['week_start']);
  const items = (plan.shopping || []).map(s => ({ name: s.name, quantity: s.quantity || null, source_app: 'trainer' }));
  if (items.length) await cloudUpsert('shared_shopping_items', items, ['name']);
  return { pushed: true, items: items.length };
}

export async function currentMealPlan() {
  const rows = await logs.all('mealplans');
  const current = rows.filter(r => r.plan?.week_start === mondayOf()).pop();
  return current?.plan || null;
}

/* ---------- photo food logging (SPEC §5.3) ---------- */
export function downscaleImage(file, maxDim = 1024) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.8).split(',')[1]);
    };
    img.onerror = () => reject(new Error('Could not read that image.'));
    img.src = URL.createObjectURL(file);
  });
}

/* Text-described meals get the same AI nutrition estimate as photos. */
export async function estimateMealFromText(desc) {
  const text = await claude(
    'Estimate the nutrition of this meal as eaten (typical home portion unless stated). ' +
    'Return ONLY JSON: {"kcal":int,"protein_g":int,"carbs_g":int,"fat_g":int,"confidence":"low|medium|high"}\n\n' +
    `Meal: ${desc}`, { maxTokens: 300 });
  return parseJson(text);
}

export async function estimateMealFromPhoto(base64jpeg) {
  const text = await claude([
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64jpeg } },
    { type: 'text', text:
      'Estimate this meal. Return ONLY JSON: {"desc":"short name of the meal",' +
      '"kcal":int,"protein_g":int,"carbs_g":int,"fat_g":int,"confidence":"low|medium|high"}. ' +
      'Estimate the visible portion, not a standard serving.' },
  ], { maxTokens: 300 });
  return parseJson(text);
}

require("dotenv").config({ path: ".env.local" });

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Fetch ALL distinct course_code_fk values from sections, paginating past the 1000-row default limit
async function getAllActiveCourseCodes() {
  const codes = new Set();
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("sections")
      .select("course_code_fk")
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`Failed to fetch sections: ${error.message}`);

    data.forEach(s => { if (s.course_code_fk) codes.add(s.course_code_fk); });

    if (data.length < pageSize) break;
    from += pageSize;
  }

  return codes;
}

(async () => {
  console.log("Fetching all active course codes from sections...");
  const codesWithSections = await getAllActiveCourseCodes();
  console.log(`Found ${codesWithSections.size} distinct course codes referenced in sections`);

  if (codesWithSections.size === 0) {
    console.error("No course codes found in sections table — aborting to prevent wiping all courses");
    process.exit(1);
  }

  // Fetch all courses and compute the difference in JS to avoid huge URL query strings
  console.log("Fetching all courses...");
  const allCourses = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("courses")
      .select("course_code, course_title")
      .range(from, from + pageSize - 1);
    if (error) { console.error("Failed to fetch courses:", error.message); process.exit(1); }
    allCourses.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  const toDelete = allCourses.filter(c => !codesWithSections.has(c.course_code));

  if (toDelete.length === 0) {
    console.log("Nothing to delete — all courses have associated sections");
    return;
  }

  console.log(`\n${toDelete.length} / ${allCourses.length} course(s) have no sections and will be deleted:`);
  toDelete.forEach(c => console.log(`  ${c.course_code}  ${c.course_title ?? ""}`));

  // Delete in batches of 100 to avoid URL length limits
  console.log("\nProceeding with deletion...");
  const batchSize = 100;
  for (let i = 0; i < toDelete.length; i += batchSize) {
    const batch = toDelete.slice(i, i + batchSize).map(c => c.course_code);
    const { error } = await supabase.from("courses").delete().in("course_code", batch);
    if (error) { console.error(`Delete failed on batch ${i / batchSize + 1}:`, error.message); process.exit(1); }
  }

  console.log(`Done — deleted ${toDelete.length} course(s)`);
})();

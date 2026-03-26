// For support, contact: qfaizaan@gmail.com

require("dotenv").config({ path: ".env.local" });

const axios = require("axios");
const puppeteer = require("puppeteer");
const { createClient } = require("@supabase/supabase-js");
const qs = require("qs");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const apiUrl = "https://loris.wlu.ca/register/ssb/registration/";
const coursesURL = "https://loris.wlu.ca/register/ssb/courseSearchResults/courseSearchResults/";
const courseDetailsURL = "https://loris.wlu.ca/register/ssb/searchResults/searchResults/";
const professorAndMeetingTimesURL = "https://loris.wlu.ca/register/ssb/searchResults/getFacultyMeetingTimes";

// Returns the list of terms to scrape based on the current date.
// Winter (Jan–Apr): current Winter + Spring
// Spring (May–Aug): current Spring + Fall + next Winter + next Spring
// Fall  (Sep–Dec): current Fall + next Winter + next Spring
function getTermsToScrape() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  const term = (y, suffix, season) => ({ code: `${y}${suffix}`, name: `${season} ${y}` });

  if (month <= 4) {
    return [
      term(year, "01", "Winter"),
      term(year, "05", "Spring"),
    ];
  } else if (month <= 8) {
    return [
      term(year, "05", "Spring"),
      term(year, "09", "Fall"),
      term(year + 1, "01", "Winter"),
      term(year + 1, "05", "Spring"),
    ];
  } else {
    return [
      term(year, "09", "Fall"),
      term(year + 1, "01", "Winter"),
      term(year + 1, "05", "Spring"),
    ];
  }
}

// Navigates to LORIS, selects the given term by its display name (e.g. "Winter 2026")
// in the select2 dropdown, and returns the session cookies.
async function getCookies(page, termName) {
  await page.goto(apiUrl);
  await page.waitForSelector("#catalogSearchLink");
  await page.click("#catalogSearchLink");
  await page.waitForSelector("a.select2-choice");
  await new Promise(resolve => setTimeout(resolve, 2000));
  await page.click("a.select2-choice");

  // Wait for the dropdown to open, then wait for actual results (not the "Searching..." placeholder)
  await page.waitForSelector(".select2-drop-active", { visible: true });
  await page.waitForSelector(".select2-drop-active li.select2-result", { visible: true });

  // Use Puppeteer element handles so the real mouse event fires and select2 registers it
  const options = await page.$$(".select2-drop-active li.select2-result");
  let clicked = false;
  for (const option of options) {
    const text = await page.evaluate(el => el.textContent.trim(), option);
    if (text === termName) {
      await option.click();
      clicked = true;
      break;
    }
  }

  if (!clicked) {
    const available = await page.evaluate(() =>
      [...document.querySelectorAll(".select2-drop-active li.select2-result")]
        .map(li => li.textContent.trim())
    );
    throw new Error(`Term "${termName}" not found. Available: ${available.join(", ")}`);
  }

  await page.click("button#term-go");
  await new Promise(resolve => setTimeout(resolve, 5000));
  await page.click("button#search-go");
  await new Promise(resolve => setTimeout(resolve, 5000));

  const buttons = await page.$$("table#table1 button.form-button.search-section-button");
  await buttons[0].click();

  const hijackedCookies = await page.cookies();
  return hijackedCookies.slice(0, 5).map(c => `${c.name}=${c.value}`);
}

async function reset(axiosInstance, retryCount = 0) {
  try {
    await axiosInstance.post(
      "https://loris.wlu.ca/register/ssb/courseSearch/resetDataForm",
      "resetCourses=false&resetSections=true"
    );
  } catch (error) {
    if (retryCount < 5) {
      console.error(`Reset failed, retrying (attempt ${retryCount + 1})...`);
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
      await reset(axiosInstance, retryCount + 1);
    } else {
      console.error("Reset failed after 5 retries");
    }
  }
}

function removeAllSpaces(str) {
  return str.replace(/\s/g, "");
}

function cleanCourseTitle(courseTitle) {
  const entities = { "&amp;": "&", "&quot;": '"', "&lt;": "<", "&gt;": ">" };
  let title = courseTitle;
  for (const [entity, replacement] of Object.entries(entities)) {
    title = title.replace(new RegExp(entity, "g"), replacement);
  }
  return title.replace(/[$+,:;=?@#|'<>.^*()%!-]/g, " ").replace(/\s+/g, " ").trim();
}

async function getCoursesTotalCount(term, axiosInstance, retryCount = 0) {
  await reset(axiosInstance);
  const payload = qs.stringify({
    txt_term: term, pageOffset: 0, pageMaxSize: 1,
    sortColumn: "subjectDescription", sortDirection: "asc",
  });
  try {
    const response = await axiosInstance.post(coursesURL, payload, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    return response.data.totalCount;
  } catch (error) {
    if (retryCount < 5) {
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
      return getCoursesTotalCount(term, axiosInstance, retryCount + 1);
    }
    throw error;
  }
}

async function getCoursesByPage(term, pageOffset, pageMaxSize, axiosInstance, retryCount = 0) {
  await reset(axiosInstance);
  const payload = qs.stringify({
    txt_term: term, pageOffset, pageMaxSize,
    sortColumn: "subjectDescription", sortDirection: "asc",
  });
  try {
    const response = await axiosInstance.post(coursesURL, payload, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    return response.data.data.map(el => ({
      courseCode: `${el.departmentCode} ${el.courseNumber}`,
      courseTitle: cleanCourseTitle(el.courseTitle),
    }));
  } catch (error) {
    if (retryCount < 5) {
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
      return getCoursesByPage(term, pageOffset, pageMaxSize, axiosInstance, retryCount + 1);
    }
    throw error;
  }
}

async function getSectionTotalCount(term, courseCode, axiosInstance, retryCount = 0) {
  await reset(axiosInstance);
  const payload = {
    txt_subjectcoursecombo: removeAllSpaces(courseCode),
    txt_term: term, pageOffset: 0, pageMaxSize: 1,
    sortColumn: "subjectDescription", sortDirection: "asc",
  };
  try {
    const response = await axiosInstance.post(courseDetailsURL, payload, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    return response.data.totalCount;
  } catch (error) {
    if (retryCount < 5) {
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
      return getSectionTotalCount(term, courseCode, axiosInstance, retryCount + 1);
    }
    throw error;
  }
}

// Returns an array of CRNs for one page of a course's sections.
async function getCourseCRNsByPage(courseCode, term, pageOffset, pageMaxSize, axiosInstance, retryCount = 0) {
  await reset(axiosInstance);
  const payload = {
    txt_subjectcoursecombo: removeAllSpaces(courseCode),
    txt_term: term, pageOffset, pageMaxSize,
    sortColumn: "subjectDescription", sortDirection: "asc",
  };
  try {
    const response = await axiosInstance.post(courseDetailsURL, payload, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    return response.data.data.map(el => el.courseReferenceNumber);
  } catch (error) {
    if (retryCount < 5) {
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
      return getCourseCRNsByPage(courseCode, term, pageOffset, pageMaxSize, axiosInstance, retryCount + 1);
    }
    throw error;
  }
}

async function getProfessorByCRN(term, CRN, axiosInstance, retryCount = 0) {
  try {
    const response = await axiosInstance.get(professorAndMeetingTimesURL, {
      params: { term, courseReferenceNumber: CRN },
    });
    if (!response?.data?.fmt?.[0]?.faculty) return [];
    return response.data.fmt[0].faculty.map(f => ({
      displayName: f.displayName,
      emailAddress: f.emailAddress,
    }));
  } catch (error) {
    if (retryCount < 5) {
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
      return getProfessorByCRN(term, CRN, axiosInstance, retryCount + 1);
    }
    throw error;
  }
}

// Fetches all CRNs for a course across all pages. Uses pageMaxSize=500 to minimize round-trips.
async function getAllCRNsForCourse(term, courseCode, axiosInstance) {
  const total = await getSectionTotalCount(term, courseCode, axiosInstance);
  if (total === 0) return [];
  const pageSize = 500;
  const pages = Math.ceil(total / pageSize);
  const crns = [];
  for (let i = 0; i < pages; i++) {
    const batch = await getCourseCRNsByPage(courseCode, term, i * pageSize, pageSize, axiosInstance);
    crns.push(...batch);
  }
  return crns;
}

// Scrapes all courses and sections for one term.
// Each term gets its own browser session so terms can safely run in parallel.
async function scrapeTerm({ code, name }) {
  // p-limit v5 is ESM-only, use dynamic import
  const { default: pLimit } = await import("p-limit");
  const limit = pLimit(10);

  console.log(`[${name}] Starting scrape...`);
  const browser = await puppeteer.launch({
    headless: true,
    args: process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
  });
  const page = await browser.newPage();
  const cookies = await getCookies(page, name);
  await browser.close();

  const axiosInstance = axios.create({ headers: { Cookie: cookies.join("; ") } });

  const totalCourses = await getCoursesTotalCount(code, axiosInstance);
  const pageSize = 500;
  const totalPages = Math.ceil(totalCourses / pageSize);
  console.log(`[${name}] ${totalCourses} courses, ${totalPages} page(s)`);

  for (let i = 0; i < totalPages; i++) {
    const courses = await getCoursesByPage(code, i * pageSize, pageSize, axiosInstance);

    const courseUpserts = [];
    const sectionUpserts = [];
    const instructorUpserts = [];

    for (const course of courses) {
      const crns = await getAllCRNsForCourse(code, course.courseCode, axiosInstance);
      if (crns.length === 0) {
        console.log(`[${name}]   ${course.courseCode} — no sections, skipping`);
        continue;
      }

      courseUpserts.push({ course_code: course.courseCode, course_title: course.courseTitle, total_reviews: 0 });

      console.log(`[${name}]   ${course.courseCode} "${course.courseTitle}" — ${crns.length} section(s), fetching profs...`);

      // getProfessorByCRN is a stateless GET — safe to parallelize with p-limit
      const profResults = await Promise.all(
        crns.map(crn => limit(() => getProfessorByCRN(code, crn, axiosInstance)))
      );

      for (let j = 0; j < crns.length; j++) {
        const crn = crns[j];
        const profData = profResults[j];
        let profName = null, profEmail = null;
        for (const prof of profData) {
          profName = prof.displayName.replace(/[.$#/[\]]/g, "");
          profEmail = prof.emailAddress;
        }
        console.log(`[${name}]     CRN ${crn} → ${profName ?? "no instructor"}`);
        sectionUpserts.push({
          course_registration_number: crn,
          term: code,
          instructor_name_fk: profName,
          course_code_fk: course.courseCode,
        });
        if (profName) {
          instructorUpserts.push({
            instructor_name: profName,
            instructor_email: profEmail,
            total_reviews: 0,
          });
        }
      }
    }

    // Batch all upserts for this page in 3 round-trips instead of 3 × N
    console.log(`[${name}] Page ${i + 1}/${totalPages} — upserting ${courseUpserts.length} courses, ${sectionUpserts.length} sections, ${instructorUpserts.length} instructors...`);

    const succeededCourseCodes = new Set();
    if (courseUpserts.length) {
      const { error } = await supabase.from("courses").upsert(courseUpserts, { ignoreDuplicates: true });
      if (error) {
        // Fall back to individual upserts to identify which row(s) are bad
        const failedCourses = [];
        for (const course of courseUpserts) {
          const { error: e } = await supabase.from("courses").upsert(course, { ignoreDuplicates: true });
          if (e) failedCourses.push(`${course.course_code} (${e.message})`);
          else succeededCourseCodes.add(course.course_code);
        }
        if (failedCourses.length) {
          console.error(`[${name}] Failed courses:\n  ${failedCourses.join("\n  ")}`);
        }
      } else {
        courseUpserts.forEach(c => succeededCourseCodes.add(c.course_code));
        console.log(`[${name}]   courses OK`);
      }
    }

    // Instructors must be upserted before sections due to FK constraint
    if (instructorUpserts.length) {
      const { error } = await supabase.from("instructors").upsert(instructorUpserts, { ignoreDuplicates: true });
      if (error) {
        console.error(`[${name}] Instructor batch error — falling back to individual upserts`);
        for (const instructor of instructorUpserts) {
          const { error: e } = await supabase.from("instructors").upsert(instructor, { ignoreDuplicates: true });
          if (e) console.error(`[${name}]   skipping instructor "${instructor.instructor_name}": ${e.message}`);
        }
      } else {
        console.log(`[${name}]   instructors OK`);
      }
    }

    const validSections = sectionUpserts.filter(s => succeededCourseCodes.has(s.course_code_fk));
    if (validSections.length) {
      const { error } = await supabase.from("sections").upsert(validSections, { ignoreDuplicates: true });
      if (error) {
        console.error(`[${name}] Section batch error — falling back to individual upserts`);
        for (const section of validSections) {
          const { error: e } = await supabase.from("sections").upsert(section, { ignoreDuplicates: true });
          if (e) console.error(`[${name}]   skipping CRN ${section.course_registration_number} (${section.course_code_fk}): ${e.message}`);
        }
      } else {
        console.log(`[${name}]   sections OK (${validSections.length}/${sectionUpserts.length})`);
      }
    }
    console.log(`[${name}] Page ${i + 1}/${totalPages} done`);
  }

  console.log(`[${name}] Scrape complete.`);
}

(async () => {
  const terms = getTermsToScrape();
  console.log(`Scraping terms: ${terms.map(t => t.name).join(", ")}`);
  // Each term runs in parallel with its own LORIS session
  await Promise.all(terms.map(scrapeTerm));
  console.log("All terms scraped.");
})();

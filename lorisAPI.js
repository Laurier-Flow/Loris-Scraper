// INSTRUCTIONS:
// Adjust cookies if you are changing the term you want to get CRNs for
// You can adjust the term using the predefined constants, or add more constants as needed
// For support, contact: qfaizaan@gmail.com

const axios = require("axios");
const puppeteer = require("puppeteer");
const { createClient } = require("@supabase/supabase-js");
const qs = require("qs");
const supabase = createClient("https://glgfhicgkucusxypfnyw.supabase.co", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdsZ2ZoaWNna3VjdXN4eXBmbnl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MDMwNTA5MzIsImV4cCI6MjAxODYyNjkzMn0.L27FhOZ3xVriTaZSgtPJ5KwctrQzmvkGOnXc6-NJjMo");

const FALL2023 = "202309";
const WINTER2024 = "202401";
const SPRING2024 = "202405";

// UPDATE THIS REF FOR EACH TERM
const TERM_REF = `/${SPRING2024}/`;

const apiUrl = "https://loris.wlu.ca/register/ssb/registration/";
const coursesURL = "https://loris.wlu.ca/register/ssb/courseSearchResults/courseSearchResults/";
const courseDetailsURL = "https://loris.wlu.ca/register/ssb/searchResults/searchResults/";
const professorAndMeetingTimesURL = "https://loris.wlu.ca/register/ssb/searchResults/getFacultyMeetingTimes";

// getCookies(page) takes a page from a puppeteer browser, and performs certain actions to get to the required LORIS pages.
// It then returns all browser cookies and returns them in a list
// Usage: getCookies(page)
async function getCookies(page) {
  await page.goto(apiUrl);
  await page.waitForSelector("#catalogSearchLink");
  await page.click("#catalogSearchLink");
  await page.waitForSelector("a.select2-choice");
  await page.waitForTimeout(2000);
  await page.click("a.select2-choice");
  await page.waitForTimeout(1000);
  // The amount of ArrowDown is dependant on which term you want to scrap,
  // go to Loris Registration to see how many to do
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  //
  await page.keyboard.press("Enter");
  await page.click("button#term-go");
  await page.waitForTimeout(5000);
  await page.click("button#search-go");
  await page.waitForTimeout(5000);
  let buttons = await page.$$(
    "table#table1 button.form-button.search-section-button"
  );
  await buttons[0].click();
  const hijackedCookies = await page.cookies();
  const cookies = [
    hijackedCookies[0].name + "=" + hijackedCookies[0].value,
    hijackedCookies[1].name + "=" + hijackedCookies[1].value,
    hijackedCookies[2].name + "=" + hijackedCookies[2].value,
    hijackedCookies[3].name + "=" + hijackedCookies[3].value,
    hijackedCookies[4].name + "=" + hijackedCookies[4].value,
  ];
  return cookies;
}
//

// reset(axiosInstance) takes an axios axiosInstance, and resets the data form. This operation must be performed so that
// subsequent requests to get course information work as expected
// Usage: reset(axiosInstance)
async function reset(axiosInstance, retryCount = 0) {
  try {
    await axiosInstance.post(
      "https://loris.wlu.ca/register/ssb/courseSearch/resetDataForm",
      "resetCourses=false&resetSections=true"
    );
  } catch (error) {
    if (retryCount < 5) {
      console.error('Reset data form error, reattempting (attempt' + retryCount + 1 + ')...');
      const delay = Math.pow(2, retryCount) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
      reset(axiosInstance);
    } else {
      console.error("Reset data form failed after 5 retries");
    }
  }
}
//

function removeAllSpaces(inputString) {
  return inputString.replace(/\s/g, '');
}

// getCourseInfo(courseCode, term, axiosInstance) takes in a string courseCode, string term, and axios axiosInstance.
// It initializes a payload accordingly, sends a request to get course information, and returns the response data.
// Usage: getCourseInfo('BU121', '202405', axiosInstance);
async function getCourseCRNsByPage(courseCode, term, pageOffset, pageMaxSize, dataArray, axiosInstance, retryCount = 0) {
  await reset(axiosInstance);
  const payload = {
    txt_subjectcoursecombo: removeAllSpaces(courseCode),
    txt_term: term,
    pageOffset: pageOffset,
    pageMaxSize: pageMaxSize,
    sortColumn: "subjectDescription",
    sortDirection: "asc",
  }

  const config = {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };

  try {
    const response = await axiosInstance.post(
      courseDetailsURL,
      payload,
      config
    );

    // Get the data
    const data = response.data.data;

    // Loop through the data

    data.forEach((element) => {
      // Add it to a list of maps that contains the CRN and associated course code
      dataArray.push(element.courseReferenceNumber);
    });
  } catch (error) {
    if (retryCount < 5) {
      console.error('Get course CRNs by page failed, reattemting (attempt' + retryCount + 1 + ')...');
      const delay = Math.pow(2, retryCount) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
      return getCourseCRNsByPage(courseCode, term, pageOffset, pageMaxSize, dataArray, axiosInstance);
    } else {
      console.error('Getting course CRNs by page failed after 5 retries:', error);
    }
  }
}
//

function cleanCourseTitle(courseTitle) {
  const entities = {
    '&amp;': '&',
    // Add more entities and their replacements as needed
  };

  let cleanTitle = courseTitle;
  for (const entity in entities) {
    if (Object.prototype.hasOwnProperty.call(entities, entity)) {
      cleanTitle = cleanTitle.replace(new RegExp(entity, 'g'), entities[entity]);
    }
  }

  cleanTitle = cleanTitle.replace(/[$+,:;=?@#|'<>.^*()%!-]/g, ' '); // Replace with space
  cleanTitle = cleanTitle.replace(/\s+/g, ' ').trim();

  return cleanTitle;
}

// getCoursesByPage(term, pageOffset, pageMaxSize, axiosInstance), takes a string term, an int pageOffset to determine which page to get courses from,
// an int pageMaxSize to set how many courses are listed on each page, and an axios axiosInstance
// Note that if your pageMaxSize is set to length x, you'll need to increment your pageOffset by x in a loop to get more courses iteratively, otherwise
// you will get repeated items
// Usage: getCoursesByPage('202405', 0, 50, axiosInstance)
async function getCoursesByPage(term, pageOffset, pageMaxSize, axiosInstance, retryCount = 0) {
  await reset(axiosInstance);
  const payload = {
    txt_term: term,
    pageOffset: pageOffset,
    pageMaxSize: pageMaxSize,
    sortColumn: "subjectDescription",
    sortDirection: "asc",
  };

  const payloadString = qs.stringify(payload);

  const config = {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };

  try {
    const response = await axiosInstance.post(
      coursesURL,
      payloadString,
      config
    );

    const entities = {
      '&amp;': '&',
      '&quot;': '"',
      '&lt;': '<',
      '&gt;': '>',
    };

    // Get the data
    const data = response.data.data;
    const courseInfo = [];
    // Loop through the data
    data.forEach((element) => {
      courseInfo.push({ courseCode: `${element.departmentCode} ${element.courseNumber}`, courseTitle: cleanCourseTitle(element.courseTitle) });
    });
    // Return the course info
    return courseInfo;
  } catch (error) {
    if (retryCount < 5) {
      console.error('Getting courses by page failed, reattemting (attempt' + retryCount + 1 + ')...');
      const delay = Math.pow(2, retryCount) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
      return getCoursesByPage(term, pageOffset, pageMaxSize, axiosInstance);
    } else {
      console.error('Getting courses by page failed after 5 retries:', error);
    }
  }
}
//

// getCoursesTotalCount(term, axiosInstance) takes in a string/constant term and an axios axiosInstance,
// returning the number of total courses in Loris for that term
async function getCoursesTotalCount(term, axiosInstance, retryCount = 0) {
  await reset(axiosInstance);
  const payload = {
    txt_term: term,
    pageOffset: 0,
    pageMaxSize: 10,
    sortColumn: "subjectDescription",
    sortDirection: "asc",
  };

  const payloadString = qs.stringify(payload);

  const config = {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };

  try {
    const response = await axiosInstance.post(
      coursesURL,
      payloadString,
      config
    );

    return response.data.totalCount;
  } catch (error) {
    if (retryCount < 5) {
      console.error('Getting course total count failed, reattemting (attempt' + retryCount + 1 + ')...');
      const delay = Math.pow(2, retryCount) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
      return getCoursesTotalCount(term, axiosInstance)
    } else {
      console.error('Getting course total count failed after 5 retries:', error);
    }
  }
}
//

async function getSectionTotalCount(term, courseCode, axiosInstance, retryCount = 0) {
  await reset(axiosInstance);
  const payload = {
    txt_subjectcoursecombo: removeAllSpaces(courseCode),
    txt_term: term,
    pageOffset: 0,
    pageMaxSize: 10,
    sortColumn: "subjectDescription",
    sortDirection: "asc",
  }

  const config = {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };

  try {
    const response = await axiosInstance.post(
      courseDetailsURL,
      payload,
      config
    );

    return response.data.totalCount;
  } catch (error) {
    if (retryCount < 5) {
      console.error('Getting section total count failed, reattemting (attempt' + retryCount + 1 + ')...');
      const delay = Math.pow(2, retryCount) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
      return getSectionTotalCount(term, courseCode, axiosInstance)
    } else {
      console.error('Getting section total count failed after 5 retries:', error);
    }
  }
}

async function getProfessorByCRN(term, CRN, axiosInstance, retryCount = 0) {
  const payload = {
    term: term,
    courseReferenceNumber: CRN
  }

  try {
    const response = await axiosInstance.get(
      professorAndMeetingTimesURL,
      {
        params: payload
      }
    );

    const profs = [];

    if (response === undefined || response.data === undefined
      || response.data.fmt[0] === undefined || response.data.fmt[0].faculty === undefined) {
      return [];
    }

    const faculty = response.data.fmt[0].faculty;

    faculty.forEach((element) => {
      profs.push({ displayName: element.displayName, emailAddress: element.emailAddress });
    });

    return profs;
  } catch (error) {
    if (retryCount < 5) {
      console.error('Getting professor by CRN failed, reattemting (attempt' + retryCount + 1 + ')...');
      const delay = Math.pow(2, retryCount) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
      return getProfessorByCRN(term, CRN, axiosInstance, retryCount + 1);
    } else {
      console.error('Getting professor by CRN failed after 5 retries:', error);
    }
  }
}

// Replace this driver code with your code to access the Loris API
(async () => {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  const cookies = await getCookies(page);
  await browser.close();

  const axiosInstance = axios.create({
    headers: {
      Cookie: cookies.join("; "),
    },
  });

  const totalCount = await getCoursesTotalCount(SPRING2024, axiosInstance);
  const pages = Math.ceil(totalCount / 500);

  for (let i = 0; i <= pages; i++) {
    console.log("////////////// Page " + i + " Begins //////////////");
    const data = await getCoursesByPage(SPRING2024, i * 500, 500, axiosInstance);
    for (d in data) {
      const sectionTotalCount = await getSectionTotalCount(SPRING2024, data[d].courseCode, axiosInstance);
      const pages2 = Math.ceil(sectionTotalCount / 50);
      let allSections = [];
      if (sectionTotalCount > 0) {
        for (let i = 0; i <= pages2; i++) {
          await getCourseCRNsByPage(data[d].courseCode, SPRING2024, i * 50, 50, allSections, axiosInstance);

          const { error } = await supabase
            .from('courses')
            .upsert({ course_code: data[d].courseCode, course_title: data[d].courseTitle, total_reviews: 0 }, { ignoreDuplicates: true })

          for (CRN in allSections) {
            const profData = await getProfessorByCRN(SPRING2024, allSections[CRN], axiosInstance);
            let profName = null;
            let profEmail = null;
            for (const prof of profData) {
              const regex = /[.$#/[\]]/g;
              profName = prof.displayName.replace(regex, '');
              profEmail = prof.emailAddress;
            }

            await supabase
              .from('sections')
              .upsert({ course_registration_number: allSections[CRN], term: SPRING2024, instructor_name_fk: profName, course_code_fk: data[d].courseCode }, { ignoreDuplicates: true });

            await supabase
              .from('instructors')
              .upsert({ instructor_name: profName, instructor_email: profEmail, total_reviews: 0 }, { ignoreDuplicates: true });
          }
        }
      }
    }
    console.log("////////////// Page " + i + " Ends //////////////");
  }

  /*
  for (let i = 0; i <= pages; i++) {
    const data = await getCoursesByPage(WINTER2024, i * 500, 500, axiosInstance);
    for (d in data) {
      const sectionTotalCount = await getSectionTotalCount(WINTER2024, d, axiosInstance);
      const pages2 = Math.ceil(sectionTotalCount / 50);
      let CRNs = [];
      for (let i = 0; i < pages2; i++) {
        await getCourseCRNsByPage(data[d], WINTER2024, i * 50, 50, CRNs, axiosInstance);
      }
      if (CRNs != []) {
        for (const CRN of CRNs) {
          const profData = await getProfessorByCRN("202309", CRN, axiosInstance);
          for (const prof of profData) {
            const regex = /[.$#/[\]]/g;
            const profName = prof.displayName.replace(regex, '');

            console.log(profName);
            console.log(prof.emailAddress);
            console.log(CRN);
          }
        };
      }
    }
    console.log("page " + i + " ended");
  }
  /*

  /*
  console.log('working!');
  const { error } = await supabase
    .from('courses')
    .insert({ course_code: 'BU111', total_reviews: 1, easy: 1, useful: 1, liked: 1 })
  */


})();
//


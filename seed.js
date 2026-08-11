const pool = require("./db");

const categories = [
  { name: "Phones", slug: "phones" },
  { name: "Electronics", slug: "electronics" },
  { name: "Fashion", slug: "fashion" },
  { name: "Beauty & Cosmetics", slug: "beauty-cosmetics" },
  { name: "Groceries", slug: "groceries" },
  { name: "Home & Living", slug: "home-living" },
];

async function seed() {
  try {
    console.log("Starting GoldMart database seed...");

    for (const category of categories) {
      await pool.query(
        `
        INSERT INTO categories (name, slug)
        VALUES ($1, $2)
        ON CONFLICT (slug) DO NOTHING
        `,
        [category.name, category.slug]
      );
    }

    console.log("Categories seeded successfully.");
  } catch (error) {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

seed();

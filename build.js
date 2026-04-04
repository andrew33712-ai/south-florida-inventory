const fs = require('fs');
const path = require('path');

// --- 1. SET UP THE FOLDERS ---
const dataPath = path.join(__dirname, 'inventory.csv'); 
const templatePath = path.join(__dirname, 'src', 'vdp-template.html');
const inventoryDir = path.join(__dirname, 'inventory'); // Puts pages directly in the main site

// Create the inventory folder if it doesn't exist
if (!fs.existsSync(inventoryDir)) fs.mkdirSync(inventoryDir, { recursive: true });

// --- 2. LOAD THE DATA & TEMPLATE ---
if (!fs.existsSync(dataPath)) {
    console.log("No inventory.csv found. Please upload it!");
    process.exit(0);
}

const rawData = fs.readFileSync(dataPath, 'utf-8');
const templateHtml = fs.readFileSync(templatePath, 'utf-8');

// Split CSV into rows
const rows = rawData.split('\n').filter(row => row.trim().length > 0);
const headers = rows[0].split(','); 

// Find column indexes
const colVin = headers.indexOf('vehicle_id');
const colTitle = headers.indexOf('title');
const colPrice = headers.indexOf('price');
const colMileage = headers.indexOf('mileage.value');
const colImage = headers.indexOf('image[0].url');

// --- 3. GENERATE THE VDP HTML PAGES ---
console.log("Starting Factory Build...");

for (let i = 1; i < rows.length; i++) {
    const columns = rows[i].split(',');
    if (columns.length < 5 || !columns[colVin]) continue;

    const vin = columns[colVin].trim();
    const title = columns[colTitle].trim();
    const image = columns[colImage] ? columns[colImage].trim() : `/${vin}.jpg`; // Fixed image path
    
    // Clean and format price and mileage
    const rawPrice = columns[colPrice].replace(' USD', '').trim();
    const formattedPrice = parseFloat(rawPrice).toLocaleString('en-US', {maximumFractionDigits: 0});
    const formattedMileage = parseInt(columns[colMileage]).toLocaleString('en-US');

    // Replace the {{TAGS}} in your HTML template
    let finalPage = templateHtml
        .replace(/{{YEAR_MAKE_MODEL}}/g, title)
        .replace(/{{PRICE}}/g, formattedPrice)
        .replace(/{{MILEAGE}}/g, formattedMileage)
        .replace(/{{IMAGE_URL}}/g, image)
        .replace(/{{VIN}}/g, vin);

    // Save the new page
    fs.writeFileSync(path.join(inventoryDir, `${vin}.html`), finalPage);
    console.log(`Generated: ${vin}.html`);
}

// --- 4. CREATE FACEBOOK FEED ---
fs.copyFileSync(dataPath, path.join(__dirname, 'facebook_catalog.csv'));
console.log("Build Complete! The machine is running.");

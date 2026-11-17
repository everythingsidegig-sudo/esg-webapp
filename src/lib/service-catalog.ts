// The ESG service catalog: 23 approved categories -> services -> subservices (spec "ESG Registration —
// Services Selection" v2.0, section 11). The 23 category names come from the spec. THE SERVICES AND
// SUBSERVICES BELOW ARE A DRAFT: the spec points at a separately approved "ESG Registration Service
// Selection — 23 Categories" master catalog that was not available, so this was written to be reviewed and
// corrected. Subservices the spec itself names (the mobile mockup's App & Software Testing, Computer
// Assistance, Mobile Devices > App Setup, Internet & Networking, Smart Home, Business > App Data Entry)
// are included exactly as drawn.
//
// Scope rules from the spec (section 12): specialized childcare, senior personal care, healthcare and
// professional legal/financial advisory are NOT part of the catalog (categories 09 and 10 are
// household/companionship help only). Services that need a licence in many places are flagged
// `regulated`: a member can record them, but they are not matched in helper search until a
// verification/eligibility control exists (spec AC-17).
//
// IDs are positional and STABLE: c<category>s<service>u<subservice> (c12s05u02). Never renumber or reorder
// shipped entries; append new ones. The database seed (migration 0041) is generated from this file by
// scripts/gen-catalog-seed.mjs, and a test fails if the two drift apart.

export type CatalogSubservice = { id: string; name: string };
export type CatalogService = { id: string; name: string; regulated: boolean; subservices: CatalogSubservice[] };
export type CatalogCategory = { id: string; name: string; services: CatalogService[] };

// [service name, subservice names, "regulated"?]
type RawService = [string, string[]] | [string, string[], "regulated"];
type RawCategory = [string, RawService[]];

const RAW: RawCategory[] = [
  ["Home Cleaning & Housekeeping", [
    ["General Cleaning", ["Regular house cleaning", "Deep cleaning", "Dusting & vacuuming", "Mopping floors", "Kitchen cleaning", "Bathroom cleaning"]],
    ["Move-in / Move-out Cleaning", ["Empty home cleaning", "Inside cabinets & appliances", "Baseboards & windows", "Post-move cleanup"]],
    ["Window & Glass Cleaning", ["Interior windows", "Exterior windows (ground level)", "Mirrors & glass doors", "Screens & tracks"]],
    ["Laundry & Linens", ["Wash, dry & fold", "Ironing", "Bed linen change", "Hand-washing delicates"]],
    ["Specialty & Post-Event Cleaning", ["Post-party cleanup", "Garage cleaning", "Basement or attic cleaning", "Oven & fridge cleaning"]],
  ]],
  ["Furniture Assembly & Installation", [
    ["Furniture Assembly", ["Beds & bed frames", "Dressers & wardrobes", "Desks & office furniture", "Bookcases & shelving units", "Tables & chairs", "Outdoor furniture"]],
    ["Wall Mounting", ["TV mounting", "Shelves & floating shelves", "Mirrors & artwork", "Curtain rods & blinds"]],
    ["Kids' & Baby Furniture Assembly", ["Cribs & changing tables", "Toddler beds", "Playsets & swings", "Kids' desks & storage"]],
    ["Disassembly & Reassembly", ["Disassemble for a move", "Reassemble after a move", "Sort & bag hardware"]],
  ]],
  ["Handyman & Minor Repairs", [
    ["General Home Repairs", ["Squeaky doors & hinges", "Patch small wall holes", "Tighten loose fixtures", "Replace door handles & basic locks", "Caulking & weatherstripping", "Replace cabinet hardware"]],
    ["Painting & Touch-ups", ["Interior touch-ups", "Single-room painting", "Trim & baseboards", "Furniture painting"]],
    ["Light Carpentry", ["Build simple shelves", "Repair wood furniture", "Door trimming", "Trim installation"]],
    ["Home Maintenance Checks", ["Smoke alarm battery changes", "Seasonal home checklist", "Light bulb replacement", "Gutter cleaning (ground level)"]],
    ["Safety & Accessory Installs", ["Towel bars & hooks", "Battery doorbells", "Child-safety gates", "Window & door stoppers"]],
  ]],
  ["Moving, Lifting & Hauling", [
    ["Loading & Unloading", ["Load a truck", "Unload a truck", "Carry furniture", "Stairs & heavy items"]],
    ["Truck & Van Hauling", ["Small furniture delivery", "Appliance pick-up & delivery", "Haul to the dump", "Donation drop-off", "Marketplace item pick-up"]],
    ["Junk Removal", ["Garage or basement cleanout", "Yard waste haul-away", "Old furniture removal", "Appliance removal"]],
    ["Heavy Lifting & Rearranging", ["Rearrange furniture", "Move items between rooms", "Move into storage"]],
    ["Packing & Unpacking", ["Pack boxes", "Wrap fragile items", "Label & organize boxes", "Unpack & set up rooms"]],
  ]],
  ["Errands, Shopping & Local Delivery", [
    ["Grocery & Shopping", ["Grocery shopping", "Gift shopping", "Store pick-ups", "Returns & exchanges", "Specialty store runs"]],
    ["Local Delivery", ["Parcel drop-off", "Takeout & food delivery", "Post office runs", "Forgotten items delivery", "Document courier"]],
    ["Waiting & Standing In", ["Wait in line", "Hold a place for an event", "Wait for a delivery or repair visit"]],
    ["Household Errands", ["Dry cleaning drop-off & pick-up", "Pet food pick-up", "Key hand-off", "Mail & package collection"]],
    ["Event Errands", ["Party supplies pick-up", "Flowers & decor pick-up", "Cake & catering pick-up"]],
  ]],
  ["Lawn, Garden & Landscaping", [
    ["Lawn Care", ["Mowing", "Edging & trimming", "Leaf raking", "Fertilizing", "Lawn clean-up"]],
    ["Garden Care", ["Weeding", "Planting flowers & shrubs", "Mulching", "Vegetable garden set-up", "Watering while away"]],
    ["Trimming & Pruning", ["Hedge trimming", "Shrub pruning", "Low tree limb pruning", "Vine trimming"]],
    ["Seasonal Yard Work", ["Spring clean-up", "Fall clean-up", "Winterizing garden beds"]],
    ["Landscaping Projects", ["Patio & path edging", "Garden bed building", "Rock & gravel spreading", "Sod laying"]],
  ]],
  ["Snow, Ice & Seasonal Outdoor", [
    ["Snow Removal", ["Shoveling driveways", "Shoveling walkways & steps", "Clearing car windows", "Snow blowing", "Clearing around mailboxes"]],
    ["Ice Management", ["Salting & de-icing", "Sanding walkways", "Chipping ice"]],
    ["Seasonal Setup & Takedown", ["Holiday lights install & removal", "Outdoor furniture storage", "Patio set-up for summer", "Storm panels & screens"]],
    ["Seasonal Cleanup", ["Leaf removal", "Pressure washing patios & walks", "Deck surface cleaning", "Gutter cleaning (ground level)"]],
    ["Winter Prep", ["Cover outdoor items", "Stack firewood", "Prepare storage space"]],
  ]],
  ["Pet Care & Animal Services", [
    ["Dog Walking", ["Daily walks", "Group walks", "Puppy visits", "Hikes with dogs"]],
    ["Pet Sitting", ["In-home pet sitting", "Overnight stays", "Drop-in visits", "Feeding & fresh water"]],
    ["Basic Pet Grooming", ["Bathing", "Brushing", "Nail trimming", "Ear & eye wipe-down"]],
    ["Basic Pet Training", ["Basic obedience", "Leash training", "Puppy socialization", "Crate training"]],
    ["Pet Transport & Errands", ["Pet taxi", "Vet drop-off & pick-up (transport only)", "Pet supply pick-up"]],
    ["Pet Home Care", ["Litter box & cage cleaning", "Basic aquarium upkeep", "Pet waste pick-up in the yard"]],
  ]],
  // Excludes babysitting, nanny and any other specialized childcare (spec section 12).
  ["Childcare & Family Assistance", [
    ["Household Help for Families", ["Family meal prep", "Laundry & folding", "Kids' room organizing", "Toy & clothing sorting"]],
    ["Baby & Child Gear Help", ["Assemble cribs & gear", "Nursery set-up", "Baby-proofing hardware (gates, outlet covers)", "Stroller & gear cleaning"]],
    ["Kids' Event Helpers", ["Party set-up & cleanup", "Party games & activities", "Balloons & decor", "Craft station help"]],
    ["Family Errands", ["School supply shopping", "Hand-me-down pick-ups", "Packing lunches & snacks", "Gift wrapping"]],
  ]],
  // Excludes senior personal care, healthcare and caregiving (spec section 12): companionship and
  // household help only.
  ["Senior & Adult Assistance", [
    ["Friendly Companionship (Non-medical)", ["Friendly visits", "Conversation & games", "Walks together", "Reading aloud", "Help with hobbies"]],
    ["Household Help for Adults", ["Light housekeeping", "Laundry", "Meal prep & cooking", "Grocery & errand runs", "Decluttering"]],
    ["Tech Help for Adults", ["Phone set-up", "Video call set-up", "Email & app help", "TV & streaming set-up"]],
    ["Outings (Non-medical)", ["Shopping trips together", "Community event outings", "Accompany on walks"]],
    ["Paper & Mail Organizing", ["Sort mail", "File & organize papers", "Binder & label set-up"]],
  ]],
  ["Personal Assistance & Home Organization", [
    ["Home Organizing", ["Closet organizing", "Pantry & kitchen organizing", "Garage organizing", "Decluttering", "Labeling systems"]],
    ["Personal Assistant Tasks", ["Calendar & scheduling help", "Phone calls & bookings", "Online research", "Reminders & follow-ups"]],
    ["Wardrobe & Packing", ["Closet clean-outs", "Seasonal wardrobe swaps", "Pack for a trip", "Unpack & put away"]],
    ["Digital Organizing", ["Photo organizing", "File & folder clean-up", "Inbox clean-up", "Backup help"]],
    ["Sorting & Selling Help", ["List items for sale", "Photograph items", "Donation drop-offs", "Garage-sale set-up"]],
  ]],
  ["Technology & Electronics", [
    ["Computer Assistance", ["Computer set-up", "Software installation & updates", "Basic virus & malware clean-up", "Printer set-up", "Data transfer to a new computer", "File backup"]],
    ["Mobile Devices", ["Phone & tablet set-up", "App Setup", "Data transfer between phones", "Screen protector & case fitting", "Photo & contact backup", "Settings & notification help"]],
    ["Internet & Networking", ["Wi-Fi set-up", "Router placement & set-up", "Extender & mesh set-up", "Streaming device set-up", "Basic network troubleshooting"]],
    ["Smart Home", ["Smart speaker set-up", "Smart bulb & plug set-up", "Video doorbell (battery or plug-in)", "Smart lock (battery) set-up", "Home hub & app set-up"]],
    ["App & Software Testing", ["User Experience & Usability Testing", "Mobile App Testing (iOS / Android)", "Website & Web App Testing", "Functional Software Testing", "Bug Testing & Verification", "Game Testing", "AI Software Testing", "Beta & Product Research Testing"]],
    ["TV, Audio & Home Theater", ["TV set-up", "Soundbar & speaker set-up", "Cable management", "Game console set-up", "Remote programming"]],
  ]],
  ["Tutoring, Teaching & Coaching", [
    ["Academic Tutoring", ["Math", "Reading & writing", "Science", "Homework help", "Test practice", "Study skills"]],
    ["Language Tutoring", ["Conversation practice", "English as a second language", "Spanish", "French", "Other language practice"]],
    ["Music & Arts Lessons", ["Guitar", "Piano & keyboard", "Singing", "Drawing & painting", "Crafts & hobby skills"]],
    ["Skills Coaching", ["Public speaking practice", "Resume & interview practice", "Sewing & knitting", "Chess & board games"]],
    ["Technology Lessons", ["Computer basics", "Smartphone basics", "Coding basics", "Online safety basics"]],
    ["Casual Sports Coaching", ["Soccer basics", "Basketball basics", "Running basics", "Tennis & racquet basics"]],
  ]],
  ["Events, Parties & Entertainment", [
    ["Party Set-up & Cleanup", ["Table & chair set-up", "Decorations", "Balloons", "Cleanup & takedown"]],
    ["Event Staffing", ["Greeter", "Coat check", "Registration table", "Guest & parking direction"]],
    ["Entertainment", ["DJ & playlist", "Party games & activities", "Face painting", "Karaoke host", "Photo booth attendant"]],
    ["Serving & Refreshments", ["Serving & clearing", "Dish washing at events", "Non-alcoholic drink station"]],
    ["Event Planning Help", ["Guest list & RSVP tracking", "Vendor errands", "Day-of coordination", "Gift & favor assembly"]],
  ]],
  ["Automotive & Bicycle Services", [
    ["Car Care & Cleaning", ["Hand wash", "Interior detailing", "Vacuum & wipe-down", "Wax & polish", "Wheel & tire cleaning"]],
    ["Basic Car Help", ["Jump-start", "Change a flat tire", "Top up washer fluid", "Replace wiper blades", "Replace a headlight bulb", "Check tire pressure"]],
    ["Bicycle Services", ["Basic tune-up", "Flat tire repair", "Chain cleaning & lube", "Brake & gear adjustment", "Bike assembly"]],
    ["Vehicle Errands", ["Fuel run", "Drop off for service", "Pick up from service", "Drive to the car wash"]],
    ["Seasonal Vehicle Prep", ["Swap seasonal tires", "Clear snow & ice", "Winter emergency kit", "Summer emergency kit"]],
  ]],
  ["Plumbing, Electrical & HVAC", [
    ["Minor Plumbing Fixes", ["Unclog a sink or toilet", "Replace a faucet or showerhead", "Fix a running toilet", "Replace washers & aerators", "Re-caulk seals"]],
    ["Minor Electrical Swaps", ["Switch plates & outlet covers", "Light bulbs", "Plug-in lighting", "Smoke & CO detector batteries"]],
    ["HVAC Upkeep", ["Change filters", "Clean vents & registers", "Window A/C install", "Thermostat batteries"]],
    ["Licensed Plumbing Work", ["Water heaters", "Pipe repair & replacement", "Hard-piped fixture installation", "Drain & sewer work"], "regulated"],
    ["Licensed Electrical Work", ["Panels & rewiring", "New outlets & circuits", "Fixture hard-wiring", "Ceiling fan wiring"], "regulated"],
    ["HVAC Installation & Repair", ["Furnaces & boilers", "Air conditioning", "Ductwork", "Gas line connections"], "regulated"],
  ]],
  ["Construction, Renovation & Skilled Trades", [
    ["Drywall & Plaster", ["Patch & repair", "Taping & mudding", "Sanding", "Texture matching"]],
    ["Larger Painting Jobs", ["Whole-room painting", "Exterior painting (ground level)", "Cabinet painting", "Wallpaper hanging", "Staining decks & fences"]],
    ["Flooring & Tiling", ["Tile installation", "Laminate & vinyl plank install", "Carpet removal", "Grout & caulk repair"]],
    ["Carpentry & Woodwork", ["Trim & molding", "Shelving & built-ins", "Door installation", "Deck & fence repair", "Custom furniture builds"]],
    ["Small Demolition & Prep", ["Small demolition", "Debris haul-out", "Floor & wall prep", "Site clean-up"]],
    ["Structural & Roofing Work", ["Framing", "Roofing", "Foundation & masonry", "Window & door openings"], "regulated"],
  ]],
  // Excludes medical care and licensed therapy (spec section 12).
  ["Beauty, Wellness & Fitness", [
    ["Personal Training & Fitness", ["Workout planning", "Walking & running partner", "Strength training basics", "Stretching & mobility basics", "Outdoor boot camp"]],
    ["Group Fitness Instruction", ["Yoga", "Pilates", "Dance fitness", "Meditation & breathing practice"]],
    ["Makeup & Styling", ["Event makeup", "Hair styling for events", "Wardrobe styling", "Personal shopping"]],
    ["Basic Nail & Beauty", ["Manicure", "Pedicure", "Nail art"], "regulated"],
    ["Wellness Coaching (Non-medical)", ["Habit coaching", "Goal setting", "Accountability partner", "Meal planning ideas"]],
  ]],
  // Excludes professional legal and financial advisory (spec section 12).
  ["Business, Office & Administrative", [
    ["App Data Entry", ["Mobile app data entry", "Web form data entry", "Spreadsheet entry", "Survey data entry", "Data clean-up"]],
    ["General Admin Help", ["Scheduling & calendars", "Email & inbox management", "Document formatting", "Filing & scanning", "Mail merge & labels"]],
    ["Research & Content Help", ["Online research", "Product & price comparison", "Proofreading", "Audio transcription", "Slide formatting"]],
    ["Customer & Office Support", ["Phone answering", "Order entry", "Appointment reminders", "Inventory counts"]],
    ["Small Business Help", ["Social media posting", "Flyers & posters", "Basic photo editing", "Website content updates", "Packing & shipping orders"]],
  ]],
  ["Photography, Video & Creative Arts", [
    ["Photography", ["Portraits", "Event photos", "Product photos", "Pet photos", "Family photos"]],
    ["Video", ["Event filming", "Video editing", "Short social videos", "Slideshows & montages", "Interview recording"]],
    ["Graphic Design & Illustration", ["Simple logo design", "Flyers & invitations", "Custom illustration", "Social media graphics"]],
    ["Music & Audio", ["Podcast editing", "Playlist creation", "Voice-over", "Live background music"]],
    ["Crafts & Handmade", ["Custom gifts", "Basic sewing & alterations", "Knitting & crochet", "Furniture upcycling"]],
  ]],
  // Excludes real-estate brokerage and professional property management advice.
  ["Travel, Vacation & Property Management", [
    ["House & Plant Sitting", ["Home check-ins", "Mail & package collection", "Plant watering", "Lights & blinds routine", "Trash bin handling"]],
    ["Vacation Rental Turnover", ["Turnover cleaning", "Linen change & laundry", "Restock supplies", "Guest key hand-off", "Photo check-in report"]],
    ["Property Watch & Checks", ["Seasonal property checks", "Storm damage walk-around (report only)", "Snow & yard checks", "Vacant property walk-through"]],
    ["Travel Help", ["Pack & unpack", "Airport drop-off", "Itinerary research", "Luggage handling"]],
  ]],
  ["Agricultural, Rural & Recreational Services", [
    ["Farm & Ranch Help", ["Animal feeding", "Barn cleaning", "Fence repair", "Hay & bale moving", "Egg collection"]],
    ["Garden & Orchard Work", ["Harvesting", "Fruit picking", "Low orchard pruning", "Composting", "Greenhouse help"]],
    ["Land & Property Care", ["Brush clearing", "Trail clearing", "Firewood splitting & stacking", "Mowing large lots", "Pond & ditch clean-up"]],
    ["Outdoor Recreation Help", ["Camp set-up", "Boat launch & dock help", "Fishing gear prep", "Hiking buddy", "Gear cleaning"]],
    ["Pesticide & Chemical Application", ["Crop spraying", "Weed-killer application", "Pest control"], "regulated"],
  ]],
  ["Cooking, Baking & Food Services", [
    ["Home Cooking", ["Family dinners", "Weekly meal prep", "Cooking for one", "Batch cooking & freezing"]],
    ["Baking", ["Cakes & cupcakes", "Bread", "Cookies & treats", "Pies", "Custom birthday cakes"]],
    ["Cooking Lessons", ["Basic cooking skills", "Baking basics", "Kids' cooking class", "Holiday dishes"]],
    ["Party Food Help", ["Appetizer platters", "Party food prep", "Kitchen helper", "Serving & plating", "Kitchen clean-up"]],
    ["Event Catering", ["Catered meals", "Buffet service", "Food sales"], "regulated"],
  ]],
];

const pad = (n: number) => String(n).padStart(2, "0");

export const CATALOG: CatalogCategory[] = RAW.map(([name, services], ci) => {
  const categoryId = `c${pad(ci + 1)}`;
  return {
    id: categoryId,
    name,
    services: services.map(([serviceName, subs, flag], si) => {
      const serviceId = `${categoryId}s${pad(si + 1)}`;
      return {
        id: serviceId,
        name: serviceName,
        regulated: flag === "regulated",
        subservices: subs.map((subName, ui) => ({ id: `${serviceId}u${pad(ui + 1)}`, name: subName })),
      };
    }),
  };
});

// Lookups by id, built once.
export const CATEGORY_BY_ID = new Map(CATALOG.map((category) => [category.id, category]));
export const SERVICE_BY_ID = new Map(CATALOG.flatMap((category) => category.services.map((service) => [service.id, { service, category }] as const)));
export const SUBSERVICE_BY_ID = new Map(CATALOG.flatMap((category) => category.services.flatMap((service) =>
  service.subservices.map((sub) => [sub.id, { sub, service, category }] as const))));

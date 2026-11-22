/* Shared static reference data (menu, meals, seeded history). Imported by both the server and the browser,
   so the server can validate every request against the same menu the student sees. */
export const MEALS = [
  { id: 'breakfast', label: 'Breakfast', icon: '🥞', start: 8 },
  { id: 'lunch', label: 'Lunch', icon: '🍛', start: 13 },
  { id: 'snack', label: 'Snacks', icon: '🫖', start: 17.5 },
  { id: 'dinner', label: 'Dinner', icon: '🌙', start: 20 },
];
export const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const M = (t, d, nv, tags) => ({ t, d, nv: !!nv, tags: tags || [] });
export const MENU = [
  { breakfast: M('Poha & Jalebi', ['Kanda Poha', 'Jalebi', 'Masala Chai'], 0, ['Light']), lunch: M('Rajma Chawal', ['Rajma Masala', 'Jeera Rice', 'Onion Salad'], 0, ['Protein']), snack: M('Samosa Time', ['Aloo Samosa', 'Green Chutney', 'Chai'], 0, ['Fried']), dinner: M('Lauki Kofta Thali', ['Lauki Kofta', 'Phulka', 'Dal Fry'], 0, ['Comfort']) },
  { breakfast: M('South Indian Start', ['Idli', 'Sambar', 'Coconut Chutney'], 0, ['Steamed']), lunch: M('Chole Bhature', ['Chole', 'Bhature', 'Pickled Onion'], 0, ['Spicy']), snack: M('Maggi Hour', ['Masala Maggi', 'Ketchup', 'Lemon Tea'], 0, ['Fun']), dinner: M('Egg Curry Rice', ['Egg Curry', 'Steamed Rice', 'Cucumber Raita'], 1, ['Protein', 'Veg option']) },
  { breakfast: M('Aloo Paratha Morning', ['Aloo Paratha', 'Curd', 'Mango Pickle'], 0, ['Hearty']), lunch: M('Kadhi Pakoda', ['Kadhi Pakoda', 'Plain Rice', 'Papad'], 0, ['Tangy']), snack: M('Sandwich Break', ['Veg Sandwich', 'Tomato Soup'], 0, ['Light']), dinner: M('Paneer Butter Masala', ['Paneer Butter Masala', 'Butter Naan', 'Jeera Rice'], 0, ['Rich']) },
  { breakfast: M('Upma & Banana', ['Rava Upma', 'Banana', 'Filter Coffee'], 0, ['Light']), lunch: M('Dal Tadka Combo', ['Dal Tadka', 'Jeera Rice', 'Bhindi Fry'], 0, ['Classic']), snack: M('Bhel Puri', ['Bhel Puri', 'Sev', 'Nimbu Pani'], 0, ['Chaat']), dinner: M('Chicken Curry Night', ['Chicken Curry', 'Steamed Rice', 'Roti'], 1, ['Protein', 'Veg option']) },
  { breakfast: M('Masala Dosa', ['Masala Dosa', 'Sambar', 'Tomato Chutney'], 0, ['Crispy']), lunch: M('Veg Biryani', ['Veg Dum Biryani', 'Mint Raita', 'Mirchi Salan'], 0, ['Festive']), snack: M('Pav Bhaji Bites', ['Mini Pav Bhaji', 'Buttermilk'], 0, ['Buttery']), dinner: M('Aloo Gobi & Roti', ['Aloo Gobi', 'Tawa Roti', 'Moong Dal'], 0, ['Homely']) },
  { breakfast: M('Puri Bhaji', ['Puri', 'Potato Bhaji', 'Sooji Halwa'], 0, ['Treat']), lunch: M('Sambar Rice', ['Sambar Rice', 'Beetroot Poriyal', 'Appalam'], 0, ['South']), snack: M('Corn Chaat', ['Masala Corn', 'Cold Coffee'], 0, ['Light']), dinner: M('Fish Fry Thali', ['Fish Fry', 'Lemon Rice', 'Rasam'], 1, ['Protein', 'Veg option']) },
  { breakfast: M('Chole Kulche', ['Chole', 'Amritsari Kulcha', 'Lassi'], 0, ['Weekend']), lunch: M('Special Pulao', ['Veg Pulao', 'Boondi Raita', 'Gulab Jamun'], 0, ['Sweet end']), snack: M('Pakora & Chai', ['Mixed Pakora', 'Masala Chai'], 0, ['Rainy mood']), dinner: M('Sunday Feast', ['Paneer Tikka Masala', 'Garlic Naan', 'Kheer'], 0, ['Feast', 'Dessert']) },
];
export const MEAL_IDS = MEALS.map(m => m.id);
export const ALL_DISHES = [...new Set(MENU.flatMap(d => Object.values(d).flatMap(m => m.d)))];

/** 14 days of seeded history (oldest first). */
export const HIST_WASTE = [92, 88, 95, 84, 80, 86, 74, 70, 72, 64, 58, 60, 52, 47];
export const HIST_SKIPS = [22, 26, 24, 31, 35, 33, 40, 42, 46, 45, 52, 58, 55, 62];

export const NGOS = ['Annadaan Food Rescue', 'Roti Bank Collective'];
export const POLL = ['Paneer Tikka Masala + Butter Naan', 'Hyderabadi Veg Dum Biryani', 'Chole Kulche Chaat Platter', 'Pav Bhaji Party'];
export const POLL_SEED = [31, 24, 19, 12];
export const RAW = [['🍚 Rice', 80], ['🍲 Dal', 40], ['🥦 Vegetables', 120]];

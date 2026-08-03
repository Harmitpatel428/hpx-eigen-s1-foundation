const axios = require('axios');
async function run() {
  try {
    const response = await axios.post('http://localhost:3000/api/v1/auth/login', {
      email: 'test@hpx.com',
      password: 'password123'
    });
    console.log('SUCCESS:', response.data);
  } catch (error) {
    if (error.response) {
      console.log('ERROR:', error.response.status, error.response.data);
    } else {
      console.log('ERROR:', error.message);
    }
  }
}
run();

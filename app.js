// Show/hide sections
function showSection(sectionId) {
    document.querySelectorAll('section').forEach(sec => {
        sec.classList.remove('active');
    });
    document.getElementById(sectionId).classList.add('active');
    
    // Close all menus when selecting an item
    document.querySelectorAll('.has-submenu').forEach(item => {
        item.classList.remove('open');
    });
}

// Video data - add more embeds as needed
const sundayVideos = [
    { title: 'Recent Sunday Service', url: 'https://www.youtube.com/embed/jzHaWseMX30' },
    { title: 'Previous Sunday Service', url: 'https://www.youtube.com/embed/OhkuBvoPX8A' },
    // Add more here: { title: '...', url: 'https://www.youtube.com/embed/...' }
];

const wednesdayVideos = [
    // Add Wednesday service embeds when available
];

// Render embedded videos
function renderVideos(containerId, videos) {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    container.innerHTML = ''; // clear previous
    videos.forEach(video => {
        const div = document.createElement('div');
        div.className = 'video-item';
        div.innerHTML = `
            <h3>${video.title}</h3>
            <iframe src="${video.url}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
        `;
        container.appendChild(div);
    });
}

// Menu toggle behavior (mobile-friendly)
document.addEventListener('DOMContentLoaded', () => {
    // Initial load
    showSection('home');
    renderVideos('sunday-videos', sundayVideos);
    renderVideos('wednesday-videos', wednesdayVideos);

    // Close menus when clicking outside
    document.addEventListener('click', function(e) {
        if (!e.target.closest('.has-submenu') && !e.target.classList.contains('menu-toggle')) {
            document.querySelectorAll('.has-submenu').forEach(item => {
                item.classList.remove('open');
            });
        }
    });

    // Toggle submenus on tap/click
    document.querySelectorAll('.menu-toggle').forEach(toggle => {
        toggle.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();

            const parent = this.closest('.has-submenu');
            const isOpen = parent.classList.contains('open');

            // Close all others
            document.querySelectorAll('.has-submenu').forEach(item => {
                item.classList.remove('open');
            });

            // Toggle current
            if (!isOpen) {
                parent.classList.add('open');
            }
        });
    });
});

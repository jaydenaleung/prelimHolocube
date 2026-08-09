#include <iostream>
#include <glad/glad.h>
#include <GLFW/glfw3.h>

// Vertex shader source code
const char* vertexShaderSource = "#version 330 core\n"
"layout (location = 0) in vec3 aPos;\n"
"void main() {\n"
"{\n"
"	gl_Position = vec4(aPos.x, aPos.y, aPos.z, 1.0);\n"
"}\0";
const char* fragmentShaderSource = "#version 330 core\n"
"out vec4 FragColor;\n"
"void main() {\n"
"{\n"
"	FragColor = vec4(1.0f, 0.5f, 0.2f, 1.0f);\n"
"}\n\0";

struct ShaderData {
	GLuint shaderProgram;
	GLuint VAO;
	GLuint VBO;
};

void checkShaderCompileErrors(GLuint shader, std::string type) {
	GLint success;
	GLchar infoLog[1024];
	if (type != "PROGRAM") {
		glGetShaderiv(shader, GL_COMPILE_STATUS, &success);
		if (!success) {
			glGetShaderInfoLog(shader, 1024, NULL, infoLog);
			std::cout << "ERROR::SHADER_COMPILATION_ERROR of type: " << type << "\n" << infoLog << "\n -- --------------------------------------------------- -- " << std::endl;
		}
	}
	else {
		glGetProgramiv(shader, GL_LINK_STATUS, &success);
		if (!success) {
			glGetProgramInfoLog(shader, 1024, NULL, infoLog);
			std::cout << "ERROR::PROGRAM_LINKING_ERROR of type: " << type << "\n" << infoLog << "\n -- --------------------------------------------------- -- " << std::endl;
		}
	}
}

ShaderData shaderSetup(GLfloat* vertices, size_t coordCount, size_t vertexCount) {
	// Shader program initialization
	GLuint vertexShader = glCreateShader(GL_VERTEX_SHADER); // Create a vertex shader
	glShaderSource(vertexShader, 1, &vertexShaderSource, NULL); // Load the vertex shader source code
	glCompileShader(vertexShader); // Compile the vertex shader for the GPU
	checkShaderCompileErrors(vertexShader, "VERTEX");

	GLuint fragmentShader = glCreateShader(GL_FRAGMENT_SHADER); // Create a fragment shader
	glShaderSource(fragmentShader, 1, &fragmentShaderSource, NULL); // Load the fragment shader source code
	glCompileShader(fragmentShader); // Compile the fragment shader for the GPU
	checkShaderCompileErrors(fragmentShader, "FRAGMENT");

	GLuint shaderProgram = glCreateProgram(); // Create a shader program
	glAttachShader(shaderProgram, vertexShader); // Attach the vertex shader to the shader program
	glAttachShader(shaderProgram, fragmentShader); // Attach the fragment shader to the shader program
	glLinkProgram(shaderProgram); // Link the shader program
	checkShaderCompileErrors(shaderProgram, "PROGRAM");

	glDeleteShader(vertexShader); // Delete the vertex shader - now in the shader program
	glDeleteShader(fragmentShader); // Delete the fragment shader

	// Generate and bind the vertex array object and vertex buffer object
	GLuint VAO, VBO;
	glGenVertexArrays(1, &VAO);
	glGenBuffers(1, &VBO);

	glBindVertexArray(VAO);
	glBindBuffer(GL_ARRAY_BUFFER, VBO);
	glBufferData(GL_ARRAY_BUFFER, coordCount * sizeof(GLfloat), vertices, GL_STATIC_DRAW);
	glVertexAttribPointer(0, vertexCount, GL_FLOAT, GL_FALSE, vertexCount * sizeof(float), (void*)0);
	glEnableVertexAttribArray(0);

	return { shaderProgram, VAO, VBO };
}

void draw(GLenum primitive, ShaderData shaderData, GLFWwindow* window) {
	GLuint shaderProgram = shaderData.shaderProgram;
	GLuint VAO = shaderData.VAO;

	glClearColor(0.0f, 0.5f, 0.7f, 1.0f); // set color
	glClear(GL_COLOR_BUFFER_BIT);
	glUseProgram(shaderProgram); // specify the shader program to use
	glBindVertexArray(VAO); // bind the vertex array object

	glDrawArrays(primitive, 0, 3); // DRAW the triangle - (which primitive?, starting index of vertices array, how many vertices?)
	glfwSwapBuffers(window); // Swap the buffer frames to update
}

int main() {
	glfwInit(); // Initialize GLFW

	GLfloat vertices[] = {
		-0.5f, -0.5f, 0.0f,
		0.5f, -0.5f, 0.0f,
		0.0f, 0.5f, 0.0f
	};

	size_t coordCount = sizeof(vertices) / sizeof(vertices[0]);
	size_t vertexCount = sizeof(vertices) / sizeof(vertices[0]) / 3;

	// Tell GLFW what version we are using for the window
	glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
	glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 3);
	glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);

	GLFWwindow* window = glfwCreateWindow(800, 800, "Holo Voxel Distributor", NULL, NULL); // Create a window

	if (window == NULL) { // Safety check/catch errors
		std::cout << "Failed to create window" << std::endl;
		glfwTerminate();
		return -1;
	}

	glfwMakeContextCurrent(window); // Make the window the current context
	gladLoadGL(); // Load OpenGL functions using glad
	glViewport(0, 0, 800, 800); // Set the viewport to the window size

	// Set up the shader and import data
	ShaderData shaderData = shaderSetup(vertices, coordCount, vertexCount);

	// Main loop
	while (!glfwWindowShouldClose(window)) {
		draw(GL_TRIANGLES, shaderData, window); // Draw the triangle
		glfwPollEvents(); // Poll for events
	}

	// Clean up when finished
	glDeleteVertexArrays(1, &shaderData.VAO);
	glDeleteBuffers(1, &shaderData.VBO);
	glDeleteProgram(shaderData.shaderProgram);

	glfwDestroyWindow(window);
	glfwTerminate();

	return 0;
}
